'use strict';

const Homey = require('homey');
const Constants = require('../../lib/intellivent-constants');
const Parser = require('../../lib/intellivent-parser');

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
      this.log(`Repair requested for ${device.getName()}`);

      // Stream progress so the user sees a slow BLE scan working rather than
      // an unexplained wait - a full rescan plus discovery can take ~40 s
      const onProgress = (message) => {
        this.log(`Repair progress: ${message}`);
        try {
          // Older clients return undefined rather than a promise here
          const sent = session.emit('repair_progress', message);
          if (sent && typeof sent.catch === 'function') sent.catch(() => {});
        } catch (err) {
          // The view may already be gone - never fail the repair over this
        }
      };

      try {
        const result = await device.runRepair(onProgress);
        this.log(`Repair finished: ${JSON.stringify(result)}`);
        return result;
      } catch (err) {
        this.error(`Repair failed: ${err.message}`);
        throw err;
      }
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
      // Discover BLE devices (ManagerBLE.discover takes no timeout parameter
      // in SDK3). Under the app-wide BLE lock: a pairing scan running while a
      // paired fan scans or connects aborts one of them, which showed up as an
      // empty list or as the other fan dropping out during pairing.
      const advertisements = await this.homey.app.withBleLock(() => this.homey.ble.discover());

      this.log(`Found ${advertisements.length} BLE devices`);

      for (const advertisement of advertisements) {
        const localName = advertisement.localName || '';

        // Filter for Intellivent devices by name. The advertised Device
        // Information service (0x180A) only counts when the advertisement has
        // no name at all: it is a standard service that plenty of unrelated
        // devices advertise, and matching on it alone listed them as fans.
        const nameMatch = localName.toLowerCase().includes(Constants.DEVICE_NAME_FILTER.toLowerCase());
        const serviceMatch = !localName && (advertisement.serviceUuids || [])
          .some((u) => Parser.uuidMatches(u, Constants.UUID_SERVICE));

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

}

module.exports = IntelliventSkyDriver;
