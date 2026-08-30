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
   * onRepair runs the repair view for an existing device.
   *
   * Repair exists because the two things that go wrong with these fans both
   * used to require deleting and re-adding the device:
   *   - the BLE link is lost and the cached advertisement is stale, so
   *     reconnects keep failing against a dead reference
   *   - the fan was put into pairing mode, but the app is holding a live
   *     connection and so never re-reads the auth code, leaving it read-only
   *
   * @param {PairSession} session - The repair session
   * @param {Device} device - The device being repaired
   */
  async onRepair(session, device) {
    this.log(`Repair started for ${device.getName()}`);

    session.setHandler('repair_start', async () => {
      // Stream progress so the user sees a slow BLE scan working rather than
      // an unexplained wait - a full rescan plus discovery can take ~40 s
      const onProgress = (message) => {
        session.emit('repair_progress', message).catch(() => {});
      };

      return device.runRepair(onProgress);
    });

    session.setHandler('disconnect', async () => {
      this.log(`Repair finished for ${device.getName()}`);
    });
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

        // Match like the upstream pyfreshintellivent scanner: name OR the
        // advertised Device Information service.
        if (nameMatch || serviceMatch) {
          this.log(`Found Intellivent device: ${localName} (${advertisement.uuid}) rssi=${advertisement.rssi}`);

          // NOTE: deliberately no BLE connect here. Connecting to the fan takes
          // ~16 s per device (the fan is slow to resolve services) which blows
          // past Homey's pairing timeout and makes the list come back empty.
          // Model/firmware info is read later, on the device's own connection.
          devices.push({
            name: localName || 'Intellivent Sky',
            data: {
              id: advertisement.uuid,
              uuid: advertisement.uuid,
              address: advertisement.address,
            },
            store: {
              peripheralUuid: advertisement.uuid,
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
