'use strict';

// node:test, not Mocha: top-level hooks are how node:test scopes to a file
/* eslint-disable mocha/no-top-level-hooks */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  Constants, FakeCharacteristic, FakePeripheral, createDevice, delay, sensorBuffer,
} = require('./helpers/fake-homey');

// Short timeouts so the hang/timeout paths run in milliseconds
const saved = {
  CONNECT_TIMEOUT: Constants.CONNECT_TIMEOUT,
  GATT_TIMEOUT: Constants.GATT_TIMEOUT,
};
Constants.CONNECT_TIMEOUT = 100;
Constants.GATT_TIMEOUT = 50;

const devices = [];
async function make(options) {
  const device = await createDevice(options);
  devices.push(device);
  return device;
}

afterEach(() => {
  for (const device of devices.splice(0)) {
    device._isDeleted = true;
    device.stopTimers();
  }
});

process.on('exit', () => Object.assign(Constants, saved));

test('a connect that finishes after its timeout releases its link instead of taking over', async () => {
  const device = await make();
  const late = new FakePeripheral();
  device.advertisement = {
    connect: () => new Promise((resolve) => setTimeout(() => resolve(late), 200)),
  };

  await assert.rejects(device._connect(), /timed out/);
  assert.strictEqual(device._peripheral, null);

  // A newer attempt connects while the abandoned one is still pending
  const current = new FakePeripheral();
  device.advertisement = { connect: async () => current };
  device._extendedCooldownUntil = 0;
  await device._connect();
  assert.strictEqual(device._peripheral, current);

  await delay(250); // the abandoned connect() resolves now
  assert.strictEqual(device._peripheral, current, 'the late link must not replace the current one');
  assert.strictEqual(late.disconnectCalls, 1, 'the late link must be released');
  assert.strictEqual(current.disconnectCalls, 0);
});

test('a hung status read times out, tears down and schedules a reconnect', async () => {
  const device = await make();
  await device._connect();
  const { peripheral } = device;
  peripheral.chars.deviceStatus.onRead = () => new Promise(() => {}); // never settles

  await device._fetchSensorData();

  assert.strictEqual(device._fetchInFlight, false, 'the poll must not stay stuck');
  assert.strictEqual(device._isConnected, false);
  assert.strictEqual(peripheral.disconnectCalls, 1);
  assert.ok(device._reconnectTimer, 'a reconnect must be scheduled');
  assert.strictEqual(device.getAvailable(), false);
});

test('any failed heartbeat read on a link that still looks connected triggers a reconnect', async () => {
  const device = await make();
  await device._connect();
  const { peripheral } = device;
  // Wording that matches none of the known disconnect messages
  peripheral.chars.deviceStatus.onRead = async () => {
    throw new Error('GATT operation failed');
  };

  await device._fetchSensorData();

  assert.strictEqual(device._isConnected, false);
  assert.strictEqual(peripheral.disconnectCalls, 1);
  assert.ok(device._reconnectTimer, 'a reconnect must be scheduled');
});

test('connection errors are recognised regardless of case', async () => {
  const device = await make();
  await device._connect();
  assert.strictEqual(device._isConnectionError(new Error('Not connected')), true);
  assert.strictEqual(device._isConnectionError(new Error('Peripheral Disconnected')), true);
  assert.strictEqual(device._isConnectionError(new Error('Write not permitted')), false);
});

test('repair fetches a new code when the fan rejects the stored one', async () => {
  const device = await make({ settings: { auth_code: 'a1b2c3d4' } });
  const { peripheral } = device;
  const { deviceStatus, auth } = peripheral.chars;

  // The fan was re-paired: the stored code is stale, the fan is in pairing
  // mode and hands out a new one, and only that one authenticates
  let authenticated = 0;
  deviceStatus.onRead = async () => sensorBuffer({ authenticated });
  auth.value = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  auth.onWrite = async (data) => {
    authenticated = Buffer.from(data).toString('hex') === '11223344' ? 1 : 0;
  };

  const result = await device.runRepair();

  assert.strictEqual(result.authenticated, true);
  assert.strictEqual(device._getAuthCode(), '11223344');
  assert.strictEqual(device._lastAuthenticated, true);
});

test('repair does not claim control when the fan still rejects authentication', async () => {
  const device = await make({ settings: { auth_code: 'a1b2c3d4' } });
  const { deviceStatus, auth } = device.peripheral.chars;
  deviceStatus.onRead = async () => sensorBuffer({ authenticated: 0 });
  auth.value = Buffer.alloc(4); // not in pairing mode: 00000000

  const result = await device.runRepair();

  assert.strictEqual(result.authenticated, false);
  assert.strictEqual(result.readOnly, false);
  assert.strictEqual(device._getAuthCode(), 'a1b2c3d4', 'the stored code must be kept');
});

test('the background poll picks up a new code when the fan reports the session unauthenticated', async () => {
  const device = await make({ settings: { auth_code: 'a1b2c3d4' } });
  const { deviceStatus, auth } = device.peripheral.chars;
  deviceStatus.onRead = async () => sensorBuffer({ authenticated: 0 });
  auth.value = Buffer.from([0x11, 0x22, 0x33, 0x44]);

  await device._fetchSensorData();

  assert.strictEqual(device._getAuthCode(), '11223344');
  assert.strictEqual(auth.writes.at(-1).toString('hex'), '11223344');
  assert.strictEqual(device._lastAuthenticated, null, 'unknown until the fan reports again');
});

test('commands are refused while the fan reports the session unauthenticated', async () => {
  const device = await make();
  device._lastAuthenticated = false;

  await assert.rejects(
    device.runUserCommand(() => device.setRpm(1500)),
    (err) => err.userFacing && err.message === 'errors.not_authenticated',
  );
  assert.strictEqual(device.peripheral.chars.temporarySpeed.writes.length, 0);
});

test('commands run once the fan reports the session authenticated', async () => {
  const device = await make();
  await device._fetchSensorData(); // default status: authenticated

  await device.runUserCommand(() => device.setRpm(1500));

  const { writes } = device.peripheral.chars.temporarySpeed;
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].readUInt16LE(1), 1500);
});

test('the operation queue keeps working after a failed operation', async () => {
  const device = await make();
  await assert.rejects(device._withConnection(async () => {
    throw new Error('boom');
  }));
  const result = await device._withConnection(async () => 'ok');
  assert.strictEqual(result, 'ok');
});

test('a command that cannot run in time fails fast and is dropped, not run late', async () => {
  const saveTimeout = Constants.USER_COMMAND_TIMEOUT;
  Constants.USER_COMMAND_TIMEOUT = 100;
  try {
    const device = await make();
    await device._connect();
    // Something slow holds the device's queue (e.g. a reconnect)
    const busy = device._withConnection(() => delay(300), { retries: 0, timeout: 0 });

    const started = Date.now();
    await assert.rejects(
      device.runUserCommand(() => device.setRpm(1500)),
      (err) => err.userFacing && err.message === 'errors.command_timeout',
    );
    assert.ok(Date.now() - started < 250, 'the caller must not wait for the queue');

    await busy;
    await delay(50);
    assert.strictEqual(device.peripheral.chars.temporarySpeed.writes.length, 0, 'the expired command must not run');
  } finally {
    Constants.USER_COMMAND_TIMEOUT = saveTimeout;
  }
});

test('a link that drops right after connecting keeps its reconnect backoff', async () => {
  const device = await make();
  const dropNow = async () => {
    device._cancelScheduledReconnect();
    device.peripheral = new FakePeripheral();
    await device._connect();
    await device.peripheral.disconnect();
  };

  await dropNow();
  assert.strictEqual(device._reconnectAttempts, 1);
  await dropNow();
  assert.strictEqual(device._reconnectAttempts, 2, 'a short-lived link must not reset the backoff');

  // A link that stayed up long enough counts as healthy again
  device._cancelScheduledReconnect();
  device.peripheral = new FakePeripheral();
  await device._connect();
  device._connectedAt -= Constants.STABLE_CONNECTION_TIME;
  await device.peripheral.disconnect();
  assert.strictEqual(device._reconnectAttempts, 1, 'a drop after a stable link retries from the start');
});

test('humidity_changed fires on a meaningful change only', async () => {
  const device = await make();
  const report = (humidity) => device._updateCapabilities({
    mode: 'constant_speed', modeRaw: 16, rpm: 1200, temperature: 21, humidity, authenticated: true,
  });
  const fired = () => device.triggers.filter((t) => t.id === 'humidity_changed').length;

  await report(50); // first reading only sets the baseline
  await report(50.4);
  await report(50.9);
  assert.strictEqual(fired(), 0);
  await report(51.1);
  assert.strictEqual(fired(), 1);
  await report(51.5);
  assert.strictEqual(fired(), 1, 'measured from where it last fired');
});

test('detection modes are not shown before the fan reports them', async () => {
  const device = await make({ capabilities: { intellivent_mode: 'constant_speed' } });

  await device.setMode('humidity');
  assert.strictEqual(device.getCapabilityValue('intellivent_mode'), 'constant_speed');
  assert.strictEqual(device.triggers.filter((t) => t.id === 'mode_changed').length, 0);

  await device.setMode('boost');
  assert.strictEqual(device.getCapabilityValue('intellivent_mode'), 'boost');
  const [trigger] = device.triggers.filter((t) => t.id === 'mode_changed');
  assert.deepStrictEqual(trigger.tokens, { mode: 'boost', mode_name: 'boost' });
});

test('the auth code moves to the store and settings only show it masked', async () => {
  const device = await make({ settings: { auth_code: 'A1B2C3D4' } });
  assert.strictEqual(device._getAuthCode(), 'a1b2c3d4');
  assert.strictEqual(device.getSetting('auth_code'), '••••••••');

  const readOnly = await make({ settings: { auth_code: '00000000' } });
  assert.strictEqual(readOnly.getSetting('auth_code'), '00000000', 'the read-only marker stays visible');
  assert.strictEqual(readOnly._isReadOnly(), true);
});

test('firmware and hardware version are read into settings on connect', async () => {
  const device = await make();
  device.peripheral.services[0].characteristics.push(
    new FakeCharacteristic('2a26', Buffer.from('1.2.3\0')), // short form, NUL padded
    new FakeCharacteristic('2a27', Buffer.from('B')),
  );

  await device._connect();

  assert.strictEqual(device.getSetting('firmware_version'), '1.2.3');
  assert.strictEqual(device.getSetting('hardware_version'), 'B');
});

test('a connection without the status characteristic is refused', async () => {
  const device = await make();
  const [service] = device.peripheral.services;
  service.characteristics = service.characteristics
    .filter((c) => c !== device.peripheral.chars.deviceStatus);

  await assert.rejects(device._connect());
  assert.strictEqual(device._isConnected, false);
});

test('the warning banner is only updated when the state changes', async () => {
  const device = await make();
  let calls = 0;
  const { setWarning } = device;
  device.setWarning = async (message) => {
    calls += 1;
    return setWarning.call(device, message);
  };
  const report = () => device._updateCapabilities({
    mode: 'constant_speed', modeRaw: 16, rpm: 1200, temperature: 21, humidity: 50, authenticated: false,
  });

  await report();
  await report();
  assert.strictEqual(calls, 1);
  assert.strictEqual(device.warning, 'errors.not_authenticated');
});
