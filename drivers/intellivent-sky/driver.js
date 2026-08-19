'use strict';

const Homey = require('homey');
const Constants = require('../../lib/intellivent-constants');

class IntelliventSkyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Intellivent Sky driver has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    this.log('Starting BLE device discovery...');

    const devices = [];

    try {
      // Discover BLE devices (ManagerBLE.discover takes no timeout parameter in SDK3)
      const advertisements = await this.homey.ble.discover();

      this.log(`Found ${advertisements.length} BLE devices`);

      for (const advertisement of advertisements) {
        const localName = advertisement.localName || '';

        // Filter for Intellivent devices: by name, or - like the upstream
        // pyfreshintellivent scanner - by the advertised Device Information
        // service when the advertisement carries no usable name
        const nameMatch = localName.toLowerCase().includes(Constants.DEVICE_NAME_FILTER.toLowerCase());
        const serviceMatch = (advertisement.serviceUuids || [])
          .some((u) => this._uuidMatches(u, Constants.UUID_SERVICE));

        if (nameMatch || (serviceMatch && !localName)) {
          this.log(`Found Intellivent device: ${localName} (${advertisement.uuid})`);

          // Try to get additional device info
          let deviceInfo = {};
          try {
            deviceInfo = await this._getDeviceInfo(advertisement);
          } catch (err) {
            this.log(`Could not get device info: ${err.message}`);
          }

          devices.push({
            name: localName || 'Intellivent Sky',
            data: {
              id: advertisement.uuid,
              uuid: advertisement.uuid,
              address: advertisement.address,
            },
            store: {
              peripheralUuid: advertisement.uuid,
              ...deviceInfo,
            },
          });
        }
      }

      this.log(`Found ${devices.length} Intellivent devices`);
      return devices;
    } catch (error) {
      this.error('Error during device discovery:', error);
      throw new Error(this.homey.__('pairing.error_discovery'));
    }
  }

  /**
   * Compare a reported characteristic UUID against a full 128-bit constant.
   * Homey may report standard 16-bit UUIDs in short form (e.g. '2a24').
   * @param {string} reported - UUID as reported by Homey
   * @param {string} expected - Full 128-bit UUID constant
   * @returns {boolean}
   */
  _uuidMatches(reported, expected) {
    const a = reported.toLowerCase().replace(/-/g, '');
    const b = expected.toLowerCase().replace(/-/g, '');
    if (a === b) return true;
    return a.length === 4 && b === `0000${a}00001000800000805f9b34fb`;
  }

  /**
   * Try to get additional device information during pairing
   * @param {BleAdvertisement} advertisement - The BLE advertisement
   * @returns {object} - Device information
   */
  async _getDeviceInfo(advertisement) {
    const info = {};

    try {
      const peripheral = await advertisement.connect();

      try {
        // Try to read device information
        const services = await peripheral.discoverAllServicesAndCharacteristics();

        for (const service of services) {
          for (const characteristic of service.characteristics) {
            try {
              if (this._uuidMatches(characteristic.uuid, Constants.MODEL_NUMBER)) {
                const data = await characteristic.read();
                info.modelNumber = data.toString('utf8').trim();
              } else if (this._uuidMatches(characteristic.uuid, Constants.FIRMWARE_VERSION)) {
                const data = await characteristic.read();
                info.firmwareVersion = data.toString('utf8').trim();
              } else if (this._uuidMatches(characteristic.uuid, Constants.HARDWARE_VERSION)) {
                const data = await characteristic.read();
                info.hardwareVersion = data.toString('utf8').trim();
              } else if (this._uuidMatches(characteristic.uuid, Constants.MANUFACTURER_NAME)) {
                const data = await characteristic.read();
                info.manufacturerName = data.toString('utf8').trim();
              }
            } catch (err) {
              // Ignore read errors for individual characteristics
            }
          }
        }
      } finally {
        await peripheral.disconnect();
      }
    } catch (err) {
      this.log(`Could not connect to device for info: ${err.message}`);
    }

    return info;
  }

}

module.exports = IntelliventSkyDriver;
