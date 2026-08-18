'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const Parser = require('../lib/intellivent-parser');
const Constants = require('../lib/intellivent-constants');

// Byte layouts and values verified against pyfreshintellivent
// (sensors.py, parser.py, helpers.py).

function sensorBuffer({
  status = 1, mode = 0, humidityRaw = 0, temperatureRaw = 0,
  unknown1 = 0, authenticated = 0, rpm = 0, avgTemperatureRaw = 0,
} = {}) {
  const buf = Buffer.alloc(15);
  buf.writeUInt8(status, 0);
  buf.writeUInt8(mode, 1);
  buf.writeUInt16LE(humidityRaw, 2);
  buf.writeUInt16LE(temperatureRaw, 4);
  buf.writeUInt8(unknown1, 6);
  buf.writeUInt8(authenticated, 7);
  buf.writeUInt16LE(rpm, 8);
  buf.writeUInt16LE(avgTemperatureRaw, 10);
  return buf;
}

test('parseSensorData reads the pyfreshintellivent field layout', () => {
  const data = Parser.parseSensorData(sensorBuffer({
    status: 1,
    mode: 49, // humidity
    humidityRaw: 4000,
    temperatureRaw: 2350,
    unknown1: 7, // must NOT be read as any real field
    authenticated: 1,
    rpm: 1375,
    avgTemperatureRaw: 2280,
  }));

  assert.strictEqual(data.status, true);
  assert.strictEqual(data.mode, 'humidity');
  assert.strictEqual(data.modeRaw, 49);
  assert.strictEqual(data.humidity, Math.round(Math.log(400) * 100) / 10); // 59.9, one decimal as upstream
  assert.strictEqual(data.temperature, 23.5);
  assert.strictEqual(data.avgTemperature, 22.8);
  assert.strictEqual(data.rpm, 1375);
  assert.strictEqual(data.authenticated, true);
});

test('parseSensorData maps the real mode byte values', () => {
  const cases = {
    0: 'off',
    6: 'pause',
    16: 'constant_speed',
    34: 'light',
    35: 'timer',
    49: 'humidity',
    52: 'voc',
    103: 'boost',
  };
  for (const [raw, expected] of Object.entries(cases)) {
    const data = Parser.parseSensorData(sensorBuffer({ mode: Number(raw) }));
    assert.strictEqual(data.mode, expected, `mode ${raw}`);
  }
  // The old (wrong) sequential values must now be unknown
  for (const raw of [1, 2, 3, 4, 5, 7]) {
    const data = Parser.parseSensorData(sensorBuffer({ mode: raw }));
    assert.strictEqual(data.mode, null, `mode ${raw} must be unknown`);
  }
});

test('parseSensorData rejects wrong lengths', () => {
  assert.throws(() => Parser.parseSensorData(Buffer.alloc(14)));
  assert.throws(() => Parser.parseSensorData(Buffer.alloc(16)));
});

test('detection levels encode as 1=low 2=medium 3=high', () => {
  assert.strictEqual(Parser.validateDetection('low'), 1);
  assert.strictEqual(Parser.validateDetection('medium'), 2);
  assert.strictEqual(Parser.validateDetection('high'), 3);
  assert.strictEqual(Parser.validateDetection(2), 2);
  assert.strictEqual(Parser.validateDetection(9), 3); // clamped
});

test('encodeHumidity writes wire sensitivity values', () => {
  assert.deepStrictEqual(
    [...Parser.encodeHumidity(true, 'high', 1200)],
    [1, 3, 0xB0, 0x04],
  );
});

test('parseHumidity decodes with the regular scale', () => {
  const parsed = Parser.parseHumidity(Buffer.from([1, 1, 0xB0, 0x04]));
  assert.strictEqual(parsed.enabled, true);
  assert.strictEqual(parsed.detection, 'low');
  assert.strictEqual(parsed.rpm, 1200);
});

test('parseLightVoc applies the light no-low and VOC reversed decode quirks', () => {
  const one = Parser.parseLightVoc(Buffer.from([1, 1, 1, 1]));
  assert.strictEqual(one.light.detection, 'medium'); // light has no "low"
  assert.strictEqual(one.voc.detection, 'high'); // VOC scale is reversed

  const three = Parser.parseLightVoc(Buffer.from([0, 3, 0, 3]));
  assert.strictEqual(three.light.detection, 'high');
  assert.strictEqual(three.voc.detection, 'low');
});

test('encodeAiring writes the magic constant in byte 1', () => {
  assert.deepStrictEqual(
    [...Parser.encodeAiring(true, 30, 1600)],
    [1, Constants.AIRING_MAGIC, 30, 0x40, 0x06],
  );
});

test('parseAiring reads minutes from byte 2', () => {
  const parsed = Parser.parseAiring(Buffer.from([1, 26, 30, 0x40, 0x06]));
  assert.deepStrictEqual(parsed, { enabled: true, minutes: 30, rpm: 1600 });
});

test('encodeBoost converts minutes to seconds', () => {
  assert.deepStrictEqual(
    [...Parser.encodeBoost(true, 2400, 10)],
    [1, 0x60, 0x09, 0x58, 0x02], // 2400 rpm, 600 s
  );
});

test('encodeAuthCode requires strict 8-char hex', () => {
  assert.deepStrictEqual([...Parser.encodeAuthCode('a1b2c3d4')], [0xA1, 0xB2, 0xC3, 0xD4]);
  assert.throws(() => Parser.encodeAuthCode('zzzzzzzz')); // would silently truncate
  assert.throws(() => Parser.encodeAuthCode('a1b2c3'));
  assert.throws(() => Parser.encodeAuthCode(''));
});

test('parseAuthCode handles binary and string forms', () => {
  assert.strictEqual(Parser.parseAuthCode(Buffer.from([0xA1, 0xB2, 0xC3, 0xD4])), 'a1b2c3d4');
  assert.strictEqual(Parser.parseAuthCode(Buffer.from('A1B2C3D4', 'utf8')), 'a1b2c3d4');
  assert.strictEqual(Parser.parseAuthCode(Buffer.alloc(4)), '00000000'); // not-in-pairing-mode marker
  assert.strictEqual(Parser.parseAuthCode(Buffer.alloc(0)), null);
});

test('validateRpm clamps to device limits', () => {
  assert.strictEqual(Parser.validateRpm(100), Constants.MIN_RPM);
  assert.strictEqual(Parser.validateRpm(9000), Constants.MAX_RPM);
  assert.strictEqual(Parser.validateRpm(1200), 1200);
});
