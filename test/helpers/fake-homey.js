/* eslint-disable max-classes-per-file */

'use strict';

// Minimal stand-in for the Homey SDK, enough to run IntelliventSkyDevice's
// connection, queue and authentication logic without a Homey or a fan.
// The real 'homey' module only exists on a Homey, so require('homey') is
// redirected here before the device is loaded.

const Module = require('node:module');
const { EventEmitter } = require('node:events');

const Constants = require('../../lib/intellivent-constants');

class FakeDevice {

  constructor({
    settings = {}, store = {}, capabilities = {}, data = {},
  } = {}) {
    this._caps = { ...capabilities };
    this._settings = { ...settings };
    this._store = { ...store };
    this._data = { uuid: 'aabbccddeeff', address: 'aa:bb:cc:dd:ee:ff', ...data };
    this._available = true;
    this.warning = null;
    this.unavailableMessage = null;
    this.listeners = {};
    this.logs = [];
    this.errors = [];
    this.triggers = [];

    const timers = new Set();
    this._timers = timers;
    this.homey = {
      __: (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key),
      setTimeout: (fn, ms) => {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
        return t;
      },
      clearTimeout: (t) => {
        timers.delete(t);
        clearTimeout(t);
      },
      setInterval: (fn, ms) => {
        const t = setInterval(fn, ms);
        timers.add(t);
        return t;
      },
      clearInterval: (t) => {
        timers.delete(t);
        clearInterval(t);
      },
      flow: {
        getDeviceTriggerCard: (id) => ({
          trigger: async (device, tokens) => {
            this.triggers.push({ id, tokens });
          },
        }),
      },
      app: {
        withBleLock: (fn) => fn(),
        findAdvertisement: async () => this.advertisement,
      },
    };

    this.log = (...args) => this.logs.push(args.join(' '));
    this.error = (...args) => this.errors.push(args.join(' '));
  }

  /** Clear every timer the device left running */
  stopTimers() {
    for (const t of this._timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this._timers.clear();
  }

  getName() {
    return 'Test fan';
  }

  getData() {
    return this._data;
  }

  hasCapability(cap) {
    return cap in this._caps;
  }

  async addCapability(cap) {
    this._caps[cap] = null;
  }

  getCapabilityValue(cap) {
    return cap in this._caps ? this._caps[cap] : null;
  }

  async setCapabilityValue(cap, value) {
    this._caps[cap] = value;
  }

  registerCapabilityListener(cap, fn) {
    this.listeners[cap] = fn;
  }

  getSetting(key) {
    return this._settings[key];
  }

  getSettings() {
    return { ...this._settings };
  }

  async setSettings(values) {
    Object.assign(this._settings, values);
  }

  getStore() {
    return { ...this._store };
  }

  getStoreValue(key) {
    return this._store[key];
  }

  async setStoreValue(key, value) {
    this._store[key] = value;
  }

  getAvailable() {
    return this._available;
  }

  async setAvailable() {
    this._available = true;
    this.unavailableMessage = null;
  }

  async setUnavailable(message) {
    this._available = false;
    this.unavailableMessage = message;
  }

  async setWarning(message) {
    this.warning = message;
  }

  async unsetWarning() {
    this.warning = null;
  }

}

const FakeHomey = {
  Device: FakeDevice,
  Driver: class {},
  App: class {},
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return FakeHomey;
  return originalLoad.call(this, request, ...rest);
};

/**
 * Build a 15-byte DEVICE_STATUS payload
 * @param {object} fields - Field overrides
 * @returns {Buffer}
 */
function sensorBuffer({
  mode = 16, humidityRaw = 4000, temperatureRaw = 2350, authenticated = 1, rpm = 1200,
} = {}) {
  const buf = Buffer.alloc(15);
  buf.writeUInt8(1, 0);
  buf.writeUInt8(mode, 1);
  buf.writeUInt16LE(humidityRaw, 2);
  buf.writeUInt16LE(temperatureRaw, 4);
  buf.writeUInt8(authenticated, 7);
  buf.writeUInt16LE(rpm, 8);
  return buf;
}

/**
 * A characteristic whose read and write behaviour tests can swap out
 */
class FakeCharacteristic {

  constructor(uuid, value = Buffer.alloc(0)) {
    this.uuid = uuid;
    this.value = value;
    this.writes = [];
    this.onRead = null;
    this.onWrite = null;
  }

  async read() {
    if (this.onRead) return this.onRead();
    return this.value;
  }

  async write(data) {
    this.writes.push(Buffer.from(data));
    if (this.onWrite) await this.onWrite(data);
  }

  async subscribeToNotifications() {
    // Notifications are not simulated
  }

  async unsubscribeFromNotifications() {
    // Notifications are not simulated
  }

}

/**
 * A peripheral exposing every characteristic the driver uses
 */
class FakePeripheral extends EventEmitter {

  constructor() {
    super();
    this.isConnected = true;
    this.disconnectCalls = 0;
    this.chars = {
      deviceStatus: new FakeCharacteristic(Constants.DEVICE_STATUS, sensorBuffer()),
      auth: new FakeCharacteristic(Constants.AUTH, Buffer.alloc(4)),
      humidity: new FakeCharacteristic(Constants.HUMIDITY, Buffer.from([1, 2, 0xB0, 0x04])),
      lightVoc: new FakeCharacteristic(Constants.LIGHT_VOC, Buffer.from([1, 2, 1, 2])),
      constantSpeed: new FakeCharacteristic(Constants.CONSTANT_SPEED, Buffer.from([1, 0xB0, 0x04])),
      timer: new FakeCharacteristic(Constants.TIMER),
      airing: new FakeCharacteristic(Constants.AIRING),
      pause: new FakeCharacteristic(Constants.PAUSE),
      boost: new FakeCharacteristic(Constants.BOOST),
      temporarySpeed: new FakeCharacteristic(Constants.TEMPORARY_SPEED),
    };
    this.services = [{
      uuid: 'service',
      characteristics: Object.values(this.chars),
      discoverCharacteristics: async () => {},
    }];
  }

  async discoverServices() {
    return this.services;
  }

  async disconnect() {
    this.disconnectCalls += 1;
    if (!this.isConnected) return;
    this.isConnected = false;
    this.emit('disconnect');
  }

}

const IntelliventSkyDevice = require('../../drivers/intellivent-sky/device');

/**
 * Create an initialised device without its background poll
 * @param {object} options - FakeDevice options
 * @returns {Promise<IntelliventSkyDevice>}
 */
async function createDevice(options = {}) {
  const device = new IntelliventSkyDevice({
    settings: { auth_code: 'a1b2c3d4', ...options.settings },
    store: { sensitivityIdsMigrated: true, ...options.store },
    capabilities: {
      onoff: true,
      measure_rpm: null,
      measure_humidity: null,
      measure_temperature: null,
      intellivent_mode: null,
      intellivent_rpm: 1200,
      intellivent_boost: null,
      intellivent_humidity_enabled: true,
      intellivent_humidity_sensitivity: '2',
      intellivent_light_enabled: true,
      intellivent_light_sensitivity: '2',
      intellivent_voc_enabled: true,
      intellivent_voc_sensitivity: '2',
      ...options.capabilities,
    },
  });
  device.peripheral = new FakePeripheral();
  device.advertisement = { connect: async () => device.peripheral };

  // onInit starts the poll and a first fetch; tests drive those themselves
  device._startPolling = () => {};
  device._fetchSensorData = async () => {};
  await device.onInit();
  delete device._startPolling;
  delete device._fetchSensorData;
  return device;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  Constants,
  FakeCharacteristic,
  FakePeripheral,
  createDevice,
  delay,
  sensorBuffer,
};
