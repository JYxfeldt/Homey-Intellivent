'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

require('./helpers/fake-homey'); // provides the 'homey' module
const IntelliventSkyDriver = require('../drivers/intellivent-sky/driver');

test('pairing scans under the BLE lock and lists only Intellivent fans', async () => {
  const driver = new IntelliventSkyDriver();
  let locked = 0;
  driver.log = () => {};
  driver.error = () => {};
  driver.homey = {
    __: (key) => key,
    app: {
      withBleLock: (fn) => {
        locked += 1;
        return fn();
      },
    },
    ble: {
      discover: async () => [
        { uuid: 'a', localName: 'Intellivent Sky', serviceUuids: [] },
        { uuid: 'b', localName: 'Fitness watch', serviceUuids: ['180a'] },
        { uuid: 'c', localName: '', serviceUuids: ['0000180a-0000-1000-8000-00805f9b34fb'] },
        { uuid: 'd', localName: '', serviceUuids: [] },
      ],
    },
  };

  const devices = await driver.onPairListDevices();

  assert.strictEqual(locked, 1);
  assert.deepStrictEqual(devices.map((d) => d.data.id), ['a', 'c']);
});
