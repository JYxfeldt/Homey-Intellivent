'use strict';

const Homey = require('homey');

// Homey's BLE manager serves one radio. Two devices scanning or connecting at
// the same instant abort each other's scan, which surfaces as an immediate
// "Peripheral Not Found" even though the fan is advertising normally. Every
// BLE operation in this app therefore goes through one app-wide lock.
const BLE_SCAN_TIMEOUT = 20000; // ms per discover() sweep - the fans advertise slowly
// One sweep only. Homey serves discover() from its advertisement cache, so a
// second back-to-back sweep returns the identical list milliseconds later and
// buys nothing - while the extra scan churn measurably destabilises the BLE
// stack when several devices are retrying.
const BLE_FIND_ATTEMPTS = 1;
const BLE_SEEN_LOG_LIMIT = 8; // peripherals listed when a lookup misses

class IntelliventApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Intellivent Fresh app has been initialized');

    // Tail of the app-wide BLE operation queue
    this._bleQueue = Promise.resolve();

    // Register flow cards
    this._registerFlowCards();
  }

  /**
   * Run a BLE operation with exclusive access to the radio.
   * Serialises across ALL devices of this app - Homey's BLE manager cannot
   * service two scans/connects concurrently, and the loser fails instantly
   * with a misleading "Peripheral Not Found".
   * @param {Function} operation - The operation to run
   * @returns {*} - Result of the operation
   */
  async withBleLock(operation) {
    // The stored tail must never be a rejected promise: chaining onto a
    // rejection would replay a stale error for every later caller.
    const run = this._bleQueue.catch(() => {}).then(() => operation());
    this._bleQueue = run.catch(() => {});
    return run;
  }

  /**
   * Locate a peripheral's advertisement.
   *
   * homey.ble.find() alone is not reliable here: it resolves against whatever
   * the manager happens to have cached and throws "Peripheral Not Found"
   * without a meaningful scan when the cache is cold or another scan just ran.
   * The fallback runs explicit discover() sweeps and matches on uuid OR
   * address, since the two are reported inconsistently across Homey firmware
   * versions (uuid is usually the MAC without separators, but not always).
   *
   * Must be called inside withBleLock().
   * @param {string} uuid - Peripheral uuid stored at pairing time
   * @param {string} [address] - MAC address stored at pairing time
   * @returns {BleAdvertisement} - The advertisement
   */
  async findAdvertisement(uuid, address) {
    const wanted = new Set(
      [uuid, address].filter(Boolean).map((v) => IntelliventApp.normaliseId(v)),
    );

    // Fast path: the manager may already hold a fresh advertisement
    try {
      const advertisement = await this.homey.ble.find(uuid, BLE_SCAN_TIMEOUT);
      if (advertisement) return advertisement;
    } catch (err) {
      this.log(`ble.find(${uuid}) failed, falling back to discover(): ${err.message}`);
    }

    for (let attempt = 1; attempt <= BLE_FIND_ATTEMPTS; attempt++) {
      const advertisements = await this.homey.ble.discover([], BLE_SCAN_TIMEOUT);
      this.log(`discover() sweep ${attempt}: ${advertisements.length} peripherals`);

      for (const advertisement of advertisements) {
        const ids = [advertisement.uuid, advertisement.address]
          .filter(Boolean)
          .map((v) => IntelliventApp.normaliseId(v));
        if (ids.some((id) => wanted.has(id))) {
          this.log(`Matched ${uuid} via discover() (uuid=${advertisement.uuid}, address=${advertisement.address}, rssi=${advertisement.rssi})`);
          return advertisement;
        }
      }

      // Log what WAS seen - distinguishes "fan is absent" from "BLE stack is
      // wedged and sees nothing", which look identical from the error alone.
      // Capped: this runs on every failed reconnect of every device.
      const seen = advertisements
        .slice(0, BLE_SEEN_LOG_LIMIT)
        .map((a) => `${a.uuid}/${a.localName || '-'}`)
        .join(', ');
      const more = advertisements.length > BLE_SEEN_LOG_LIMIT
        ? ` (+${advertisements.length - BLE_SEEN_LOG_LIMIT} more)`
        : '';
      this.log(`Peripheral ${uuid} not found. Saw ${advertisements.length}: ${seen}${more}`);
    }

    throw new Error(`Peripheral Not Found: ${uuid}`);
  }

  /**
   * Normalise a BLE identifier for comparison (lowercase, no separators)
   * @param {string} value - uuid or MAC address
   * @returns {string}
   */
  static normaliseId(value) {
    return String(value).toLowerCase().replace(/[:-]/g, '');
  }

  /**
   * Register flow cards for automation
   */
  _registerFlowCards() {
    // Trigger: Mode changed
    this.homey.flow.getDeviceTriggerCard('mode_changed');

    // Trigger: Humidity changed
    this.homey.flow.getDeviceTriggerCard('humidity_changed');

    // Condition: Mode is
    this.homey.flow.getConditionCard('mode_is')
      .registerRunListener(async (args) => {
        const currentMode = args.device.getCapabilityValue('intellivent_mode');
        return currentMode === args.mode;
      });

    // Action: Set mode
    this.homey.flow.getActionCard('set_mode')
      .registerRunListener(async (args) => {
        await args.device.setMode(args.mode);
      });

    // Action: Set RPM
    this.homey.flow.getActionCard('set_rpm')
      .registerRunListener(async (args) => {
        await args.device.setRpm(args.rpm);
      });

    // Action: Start boost
    this.homey.flow.getActionCard('start_boost')
      .registerRunListener(async (args) => {
        await args.device.startBoost(args.duration, args.rpm);
      });

    // Action: Configure humidity detection
    this.homey.flow.getActionCard('configure_humidity')
      .registerRunListener(async (args) => {
        const enabled = args.enabled === 'true';
        const sensitivity = parseInt(args.sensitivity, 10);
        await args.device.configureHumidity(enabled, sensitivity, args.rpm);
      });
  }

}

module.exports = IntelliventApp;
