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
      // Discover BLE devices
      const advertisements = await this.homey.ble.discover([], 20000);

      this.log(`Found ${advertisements.length} BLE devices`);

      for (const advertisement of advertisements) {
        const localName = advertisement.localName || '';

        // Filter for Intellivent devices
        if (localName.toLowerCase().includes(Constants.DEVICE_NAME_FILTER.toLowerCase())) {
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
            const uuid = characteristic.uuid.toLowerCase();

            try {
              if (uuid === Constants.MODEL_NUMBER.replace(/-/g, '')) {
                const data = await characteristic.read();
                info.modelNumber = data.toString('utf8').trim();
              } else if (uuid === Constants.FIRMWARE_VERSION.replace(/-/g, '')) {
                const data = await characteristic.read();
                info.firmwareVersion = data.toString('utf8').trim();
              } else if (uuid === Constants.HARDWARE_VERSION.replace(/-/g, '')) {
                const data = await characteristic.read();
                info.hardwareVersion = data.toString('utf8').trim();
              } else if (uuid === Constants.MANUFACTURER_NAME.replace(/-/g, '')) {
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
