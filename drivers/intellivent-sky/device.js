'use strict';

const Homey = require('homey');
const Constants = require('../../lib/intellivent-constants');
const Parser = require('../../lib/intellivent-parser');

class IntelliventSkyDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Intellivent Sky device has been initialized');

    // Initialize state
    this._peripheral = null;
    this._characteristics = {};
    this._pollInterval = null;
    this._isConnecting = false;
    this._isConnected = false;
    this._notificationsSubscribed = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._consecutiveConnectFailures = 0;
    this._fetchInFlight = false;
    this._sessionStartedAt = 0;
    this._operationQueue = Promise.resolve();
    this._updateChain = Promise.resolve();
    this._isDeleted = false;

    // Device-held configuration cached per connection (readback + own
    // writes), used to rebuild shared payloads without clobbering values set
    // outside Homey. Cleared on teardown - it is only trusted while the
    // connection it was read on is alive.
    this._deviceConfig = {};

    // Rate limiting state
    this._connectionFailures = []; // Timestamps of recent failures
    this._extendedCooldownUntil = 0; // Timestamp when extended cooldown ends
    this._lastAuthRegenTime = 0; // Timestamp of last auth code regeneration
    this._lastAuthRetry = 0; // Timestamp of last read-only re-auth attempt
    this._intentionalDisconnect = false; // True while we are tearing down on purpose
    this._forceRescan = false; // True while a repair wants a cache-bypassing scan

    // Ensure new capabilities exist on already-paired devices
    await this._migrateCapabilities();

    // Surface device info captured during pairing into the settings labels
    const store = this.getStore();
    const infoSettings = {};
    if (store.firmwareVersion) infoSettings.firmware_version = store.firmwareVersion;
    if (store.hardwareVersion) infoSettings.hardware_version = store.hardwareVersion;
    if (Object.keys(infoSettings).length > 0) {
      await this.setSettings(infoSettings).catch(this.error);
    }

    // Register capability listeners
    this._registerCapabilityListeners();

    // Start polling for sensor data
    this._startPolling();

    // Initial data fetch
    this._fetchSensorData();
  }

  /**
   * Check if the device is in read-only mode
   * Device is read-only when auth code is 00000000
   * @returns {boolean} - True if read-only
   */
  _isReadOnly() {
    const authCode = this.getSetting('auth_code');
    return authCode === '00000000';
  }

  /**
   * Throw an error if the device is in read-only mode
   * @throws {Error} - If device is read-only
   */
  _checkWriteAccess() {
    if (this._isReadOnly()) {
      throw new Error(this.homey.__('errors.read_only'));
    }
  }

  /**
   * Add capabilities that were introduced after initial pairing
   */
  async _migrateCapabilities() {
    const newCapabilities = ['measure_rpm', 'intellivent_boost'];
    for (const cap of newCapabilities) {
      if (!this.hasCapability(cap)) {
        this.log(`Adding missing capability: ${cap}`);
        await this.addCapability(cap);
      }
    }

    // v0.2.0 changed the sensitivity enum ids from 0/1/2 to the protocol wire
    // values 1/2/3 (same labels, same order). One-shot migration of stored
    // values from devices paired on earlier versions. The flag is written
    // FIRST: if it fails, nothing is migrated (values stay old, retried next
    // boot); the reverse order could re-run a completed migration and bump
    // every sensitivity one more level.
    if (!this.getStoreValue('sensitivityIdsMigrated')) {
      try {
        await this.setStoreValue('sensitivityIdsMigrated', true);
      } catch (err) {
        // Can't persist the flag - defer the whole migration to a later boot
        // rather than risk re-running it (or failing device init)
        this.error(`Could not persist migration flag, deferring migration: ${err.message}`);
        return;
      }
      const idMap = { 0: '1', 1: '2', 2: '3' };
      const sensitivityCaps = [
        'intellivent_humidity_sensitivity',
        'intellivent_light_sensitivity',
        'intellivent_voc_sensitivity',
      ];
      for (const cap of sensitivityCaps) {
        if (this.hasCapability(cap)) {
          const mapped = idMap[this.getCapabilityValue(cap)];
          if (mapped) {
            this.log(`Migrating ${cap} enum id to ${mapped}`);
            await this.setCapabilityValue(cap, mapped).catch(this.error);
          }
        }
      }
    }
  }

  /**
   * Register capability listeners
   */
  _registerCapabilityListeners() {
    // On/Off capability
    this.registerCapabilityListener('onoff', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting onoff to ${value}`);
      await this._withConnection(async () => {
        if (value) {
          // Turn on - set to constant speed mode at the configured RPM
          const rpm = this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM;
          await this._setConstantSpeed(true, rpm);
        } else {
          // Turn off - disable all modes by pausing
          await this._setPause(true, 0);
        }
      });
    });

    // Mode capability
    this.registerCapabilityListener('intellivent_mode', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting mode to ${value}`);
      await this.setMode(value);
    });

    // RPM capability
    this.registerCapabilityListener('intellivent_rpm', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting RPM to ${value}`);
      await this.setRpm(value);
    });

    // Humidity enabled capability
    this.registerCapabilityListener('intellivent_humidity_enabled', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting humidity enabled to ${value}`);
      await this.setHumidityEnabled(value);
    });

    // Humidity sensitivity capability
    this.registerCapabilityListener('intellivent_humidity_sensitivity', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting humidity sensitivity to ${value}`);
      await this.setHumiditySensitivity(parseInt(value, 10));
    });

    // Light enabled capability
    this.registerCapabilityListener('intellivent_light_enabled', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting light enabled to ${value}`);
      await this.setLightEnabled(value);
    });

    // Light sensitivity capability
    this.registerCapabilityListener('intellivent_light_sensitivity', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting light sensitivity to ${value}`);
      await this.setLightSensitivity(parseInt(value, 10));
    });

    // VOC enabled capability
    this.registerCapabilityListener('intellivent_voc_enabled', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting VOC enabled to ${value}`);
      await this.setVocEnabled(value);
    });

    // VOC sensitivity capability
    this.registerCapabilityListener('intellivent_voc_sensitivity', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting VOC sensitivity to ${value}`);
      await this.setVocSensitivity(parseInt(value, 10));
    });

    // Boost button - one tap, using the speed/duration from device settings
    this.registerCapabilityListener('intellivent_boost', async () => {
      this._checkWriteAccess();
      const rpm = this.getSetting('boost_rpm') || Constants.MAX_RPM;
      const minutes = this.getSetting('boost_minutes') || Constants.DEFAULT_BOOST_MINUTES;
      this.log(`Boost button pressed: ${minutes} min at ${rpm} RPM`);
      await this.startBoost(minutes, rpm);
    });
  }

  /**
   * Start polling for sensor data.
   * The poll keeps running even when notifications are subscribed: it doubles
   * as a connection heartbeat, because the peripheral 'disconnect' event is
   * not always emitted (athombv/homey-apps-sdk-issues#315) and a silently
   * dropped connection would otherwise never be detected.
   */
  _startPolling() {
    if (this._isDeleted) return;

    // Clear any existing interval
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
    }

    this._pollInterval = this.homey.setInterval(() => {
      // While disconnected the reconnect scheduler owns the retry cadence.
      // Letting the poll fire as well used to queue a fresh fetch every
      // POLL_INTERVAL on top of one that was still backing off, so an
      // unreachable fan built an unbounded backlog of stale polls - each of
      // which kept feeding the rate limiter. That backlog then had to drain
      // before anything current ran, which is why recovery looked random and
      // took far longer than the signal did to come back.
      if (this._fetchInFlight || this._reconnectTimer) return;

      this._fetchSensorData();
    }, Constants.POLL_INTERVAL);
  }

  /**
   * Hand the session back before the fan takes it.
   *
   * The fan drops its GATT session on its own after minutes to hours, even
   * with traffic every 20 s. Per athombv/homey-apps-sdk-issues#454 a
   * peripheral-initiated drop is what wedges Homey's BLE manager into a state
   * only a full reboot clears, so the one lever this app has is to always be
   * the side that disconnects. A clean teardown here costs one reconnect;
   * losing the race costs a Homey reboot.
   *
   * Honest caveat: that a clean app-initiated disconnect avoids the wedge is
   * inference from #454, not something this app has proven. The recycle
   * interval is a device setting so it can be tuned or switched off (0).
   *
   * @returns {boolean} - True if the session was recycled
   */
  async _recycleSessionIfStale() {
    if (!this._isConnected || !this._sessionStartedAt) return false;

    const minutes = this._sessionRecycleMinutes();
    if (minutes <= 0) return false;

    const ageMs = Date.now() - this._sessionStartedAt;
    if (ageMs < minutes * 60000) return false;

    this.log(`Session is ${Math.round(ageMs / 60000)} min old, recycling it before the fan does`);
    await this._disconnect(true).catch((err) => this.log(`Recycle disconnect failed: ${err.message}`));
    this._sessionStartedAt = 0;
    return true;
  }

  /**
   * Configured session lifetime in minutes (0 disables recycling)
   * @returns {number}
   */
  _sessionRecycleMinutes() {
    const configured = this.getSetting('session_recycle_minutes');
    return Number.isFinite(configured)
      ? configured
      : Constants.DEFAULT_SESSION_RECYCLE_MINUTES;
  }

  /**
   * Ask for another connection attempt later, with capped exponential backoff.
   *
   * This is the single owner of "try again": one pending timer at a time, and
   * it never stops rescheduling. A fan that is out of range for hours recovers
   * on its own once the signal returns, instead of needing an app restart.
   */
  _scheduleReconnect() {
    if (this._isDeleted || this._reconnectTimer || this._isConnected) return;

    const delay = Math.min(
      Constants.RECONNECT_DELAY * (2 ** this._reconnectAttempts),
      Constants.MAX_RECONNECT_DELAY,
    );
    this._reconnectAttempts += 1;

    this.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = this.homey.setTimeout(() => {
      this._reconnectTimer = null;
      if (this._isDeleted || this._isConnected) return;
      this._fetchSensorData();
    }, delay);
  }

  /**
   * Cancel a pending reconnect, e.g. because a connection just succeeded
   */
  _cancelScheduledReconnect() {
    if (!this._reconnectTimer) return;
    this.homey.clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  /**
   * Reset every backoff and rate-limiting counter after a successful connect.
   * Without this the next single failure would resume the previous (possibly
   * multi-minute) backoff instead of retrying promptly.
   */
  _resetBackoff() {
    this._reconnectAttempts = 0;
    this._consecutiveConnectFailures = 0;
    this._connectionFailures = [];
    this._extendedCooldownUntil = 0;
    this._cancelScheduledReconnect();
  }

  /**
   * Check if connection is rate limited
   * @throws {Error} - If rate limited
   */
  _checkRateLimit() {
    const now = Date.now();

    // Check extended cooldown
    if (now < this._extendedCooldownUntil) {
      const remainingSeconds = Math.ceil((this._extendedCooldownUntil - now) / 1000);
      const err = new Error(`Connection rate limited. Try again in ${remainingSeconds} seconds.`);
      err.rateLimited = true;
      throw err;
    }

    // Clean up old failures outside the window
    this._connectionFailures = this._connectionFailures.filter(
      (timestamp) => now - timestamp < Constants.CONNECTION_FAILURE_WINDOW,
    );

    // Check if too many recent failures
    if (this._connectionFailures.length >= Constants.MAX_CONNECTION_FAILURES) {
      this._extendedCooldownUntil = now + Constants.EXTENDED_COOLDOWN;
      this._connectionFailures = []; // Reset after triggering cooldown
      const cooldownSeconds = Constants.EXTENDED_COOLDOWN / 1000;
      this.log(`Too many connection failures. Entering ${cooldownSeconds}s cooldown.`);
      const err = new Error(`Too many connection failures. Try again in ${cooldownSeconds} seconds.`);
      err.rateLimited = true;
      throw err;
    }
  }

  /**
   * Record a connection failure for rate limiting
   */
  _recordConnectionFailure() {
    this._connectionFailures.push(Date.now());
  }

  /**
   * Connect to the BLE device (persistent connection)
   * @returns {BlePeripheral} - The connected peripheral
   */
  async _connect() {
    // Check rate limiting before attempting connection
    this._checkRateLimit();

    // Already connected
    if (this._isConnected && this._peripheral) {
      return this._peripheral;
    }

    // Wait if connection is in progress
    if (this._isConnecting) {
      // Wait for connection to complete
      while (this._isConnecting) {
        await new Promise((resolve) => this.homey.setTimeout(resolve, 100));
      }
      if (this._isConnected && this._peripheral) {
        return this._peripheral;
      }
    }

    this._isConnecting = true;

    try {
      const { uuid, address } = this.getData();
      this.log(`Connecting to device ${uuid}...`);

      // Scanning, connecting and service discovery all share one radio across
      // the whole app: hold the app-wide BLE lock for all three. Two devices
      // doing this concurrently abort each other's scan and fail instantly
      // with "Peripheral Not Found" even when both fans advertise normally.
      //
      // The whole locked section is time-boxed. Homey's BLE connect can hang
      // indefinitely against a weak peripheral (observed: >3 min on the
      // rssi -81 fan), and an unbounded hold would starve every other device
      // of the radio for as long as it lasts.
      await this.homey.app.withBleLock(() => this._withTimeout(
        this._connectAndDiscover(uuid, address),
        Constants.CONNECT_TIMEOUT,
        'BLE connect/discovery',
      ));

      if (this._isDeleted) {
        throw new Error('Device has been deleted');
      }

      // Cache characteristics
      await this._cacheCharacteristics();

      // Authenticate if we have an auth code
      await this._authenticate();

      // Subscribe to notifications for real-time updates
      await this._subscribeToNotifications();

      // Mirror the fan's stored configuration into capabilities (non-fatal)
      await this._syncConfigFromDevice();

      if (!this._peripheral || this._peripheral.isConnected === false) {
        // The connection died during setup (the disconnect handler fired, or
        // the link dropped without an event - sdk-issues#315); 'disconnected'
        // in the message routes this to the reconnect path
        throw new Error('Device disconnected during connection setup');
      }

      this._isConnected = true;
      this._sessionStartedAt = Date.now();

      // Back to a healthy link: forget every accumulated penalty, so the next
      // isolated blip retries in 5 s rather than resuming a 5 minute backoff
      this._resetBackoff();

      return this._peripheral;
    } catch (err) {
      await this._teardownConnection();
      this._recordConnectionFailure();
      this._consecutiveConnectFailures += 1;
      throw err;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Read the fan's stored mode configuration and mirror it into capabilities.
   * Without this, toggles show whatever Homey last wrote (or defaults), and
   * config writes rebuild their payloads from those stale values, silently
   * overwriting settings made from e.g. the Fresh phone app.
   *
   * Every sensitivity is mirrored as the raw wire value, because this app's
   * enum ids ARE the wire values ('1'..'3') on both the read and the write
   * path. That round-trips losslessly: pick High -> write 3 -> read 3 ->
   * still shows High.
   *
   * This deliberately does not apply pyfreshintellivent's per-channel display
   * scales (light disable_low, VOC regular_order=False). Those exist to label
   * a value for a human, and upstream applies them asymmetrically - its
   * light_and_voc_write encodes VOC with the REGULAR order while its
   * light_and_voc_read decodes VOC reversed, so round-tripping through them
   * turns High into Low. The one display rule that is safe is light's missing
   * 'Low': the device has no low light setting, so wire 1 is shown as Medium
   * (and upstream encodes Medium back to the same value).
   *
   * Each read is isolated: one failing characteristic never blocks the rest,
   * and a failed readback never fails the connection.
   */
  async _syncConfigFromDevice() {
    try {
      const humidityChar = this._characteristics.humidity;
      if (humidityChar) {
        const humidity = Parser.parseHumidity(await humidityChar.read());
        this._deviceConfig.humidityRpm = humidity.rpm;
        this.log(`Humidity readback: enabled=${humidity.enabled} raw=${humidity.detectionRaw} rpm=${humidity.rpm}`);
        await this.setCapabilityValue('intellivent_humidity_enabled', humidity.enabled).catch(this.error);
        await this._setSensitivityCapability('intellivent_humidity_sensitivity', humidity.detectionRaw);
      }
    } catch (err) {
      this.log(`Humidity config readback failed (non-fatal): ${err.message}`);
    }

    try {
      const lightVocChar = this._characteristics.lightVoc;
      if (lightVocChar) {
        const lightVoc = Parser.parseLightVoc(await lightVocChar.read());
        this._deviceConfig.lightEnabled = lightVoc.light.enabled;
        this._deviceConfig.lightDetectionRaw = lightVoc.light.detectionRaw;
        this._deviceConfig.vocEnabled = lightVoc.voc.enabled;
        this._deviceConfig.vocDetectionRaw = lightVoc.voc.detectionRaw;
        this.log(`Light/VOC readback: light enabled=${lightVoc.light.enabled} raw=${lightVoc.light.detectionRaw}, voc enabled=${lightVoc.voc.enabled} raw=${lightVoc.voc.detectionRaw}`);

        await this.setCapabilityValue('intellivent_light_enabled', lightVoc.light.enabled).catch(this.error);
        await this.setCapabilityValue('intellivent_voc_enabled', lightVoc.voc.enabled).catch(this.error);

        // The fan has no low light setting - wire 1 and 2 are the same
        // physical level, so show the one the picker can round-trip
        const lightLevel = lightVoc.light.detectionRaw === 1 ? 2 : lightVoc.light.detectionRaw;
        await this._setSensitivityCapability('intellivent_light_sensitivity', lightLevel);
        await this._setSensitivityCapability('intellivent_voc_sensitivity', lightVoc.voc.detectionRaw);
      }
    } catch (err) {
      this.log(`Light/VOC config readback failed (non-fatal): ${err.message}`);
    }

    try {
      const constantSpeedChar = this._characteristics.constantSpeed;
      if (constantSpeedChar) {
        const constantSpeed = Parser.parseConstantSpeed(await constantSpeedChar.read());
        // Populate-once: the RPM slider is a control, not a sensor - syncing
        // it on every reconnect would snap back a value the user just chose
        if (this.getCapabilityValue('intellivent_rpm') === null
          && constantSpeed.rpm >= Constants.MIN_RPM && constantSpeed.rpm <= Constants.MAX_RPM) {
          await this.setCapabilityValue('intellivent_rpm', constantSpeed.rpm).catch(this.error);
        }
      }
    } catch (err) {
      this.log(`Constant speed config readback failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Write a sensitivity read back from the fan into its enum capability.
   * The enum ids are the wire values, so the raw byte maps straight across -
   * but a fan holding something outside 1..3 must not blank the picker with
   * an invalid value, so anything unexpected is logged and skipped.
   * @param {string} capability - Capability id
   * @param {number} raw - Raw wire value from the device
   */
  async _setSensitivityCapability(capability, raw) {
    if (!this.hasCapability(capability)) return;

    if (!Number.isInteger(raw) || raw < 1 || raw > 3) {
      this.log(`Ignoring out-of-range ${capability} value from device: ${raw}`);
      return;
    }

    await this.setCapabilityValue(capability, String(raw)).catch(this.error);
  }

  /**
   * Drop the current connection state, disconnecting the peripheral if one is
   * still held. Leaving a half-open connection would block the fan's only BLE
   * slot (e.g. for the Fresh phone app) until Homey garbage-collects it.
   */
  async _teardownConnection() {
    const peripheral = this._peripheral;
    this._isConnected = false;
    this._peripheral = null;
    this._characteristics = {};
    this._notificationsSubscribed = false;
    // Cached device config is only trusted for the connection it was read on
    this._deviceConfig = {};

    if (peripheral) {
      try {
        await peripheral.disconnect();
      } catch (err) {
        // Peripheral may already be gone - nothing to clean up
      }
    }
  }

  /**
   * Subscribe to BLE notifications on DEVICE_STATUS characteristic.
   * Falls back to polling if the characteristic does not support notifications.
   */
  async _subscribeToNotifications() {
    const char = this._characteristics.deviceStatus;
    if (!char) return;

    try {
      await char.subscribeToNotifications(async (data) => {
        try {
          const sensorData = Parser.parseSensorData(data);
          await this._queueCapabilityUpdate(sensorData);
        } catch (err) {
          this.error(`Notification parse error: ${err.message}`);
        }
      });
      this._notificationsSubscribed = true;
      this.log('Subscribed to DEVICE_STATUS notifications');
      // NOTE: polling deliberately keeps running as a heartbeat - see _startPolling()
    } catch (err) {
      this.log(`Notifications not supported, falling back to polling: ${err.message}`);
      this._notificationsSubscribed = false;
      this._startPolling();
    }
  }

  /**
   * Disconnect from the BLE device
   * @param {boolean} force - Force disconnect even if operations pending
   */
  async _disconnect(force = false) {
    if (this._peripheral) {
      // Tell the 'disconnect' handler this teardown is ours, so it does not
      // treat it as a surprise drop and schedule a competing reconnect
      this._intentionalDisconnect = true;
      // Unsubscribe from notifications before disconnecting
      if (this._notificationsSubscribed) {
        const char = this._characteristics.deviceStatus;
        if (char) {
          try {
            await char.unsubscribeFromNotifications();
          } catch (err) {
            this.log(`Error unsubscribing: ${err.message}`);
          }
        }
        this._notificationsSubscribed = false;
      }

      try {
        await this._peripheral.disconnect();
        this.log('Disconnected from device');
      } catch (err) {
        this.log(`Error disconnecting: ${err.message}`);
      }
      this._peripheral = null;
      this._characteristics = {};
      this._isConnected = false;
      this._sessionStartedAt = 0;
      this._intentionalDisconnect = false;
    }
  }

  /**
   * User-initiated repair: rebuild the connection from scratch and pick up a
   * new auth code if the fan has been put into pairing mode.
   *
   * Queued on the device's own operation queue so it never runs concurrently
   * with a poll, and it goes through the normal connect path so it inherits
   * the app-wide BLE lock. The scan is forced past Homey's advertisement
   * cache, because a stale cached advertisement is exactly what leaves normal
   * reconnects failing forever.
   *
   * @param {Function} onProgress - Called with human-readable progress lines
   * @returns {object} - { authenticated, readOnly, readings }
   */
  async runRepair(onProgress = () => {}) {
    const run = this._operationQueue
      .catch(() => {})
      .then(() => this._repairSequence(onProgress));
    this._operationQueue = run.catch(() => {});
    return run;
  }

  /**
   * The repair steps themselves. Runs inside the operation queue.
   * @param {Function} onProgress - Progress callback
   * @returns {object} - Repair result
   */
  async _repairSequence(onProgress) {
    const t = (key, tokens) => this.homey.__(`repair.${key}`, tokens);

    // A repair is an explicit user request: it must not be refused because
    // background reconnects tripped the rate limiter earlier
    this._connectionFailures = [];
    this._extendedCooldownUntil = 0;
    this._reconnectAttempts = 0;
    this._cancelScheduledReconnect();

    // Let the auth read run even if a background attempt happened recently
    this._lastAuthRegenTime = 0;
    this._lastAuthRetry = 0;

    onProgress(t('progress_disconnect'));
    await this._disconnect(true).catch(() => {});

    onProgress(t('progress_scan'));
    this._forceRescan = true;

    try {
      await this._connect();
    } finally {
      this._forceRescan = false;
    }

    onProgress(t('progress_connected'));

    // Read status directly so the result reflects this moment, not a cached
    // capability value from before the fan went away
    const char = this._characteristics.deviceStatus;
    if (!char) {
      throw new Error(t('error_no_status_characteristic'));
    }

    const sensorData = Parser.parseSensorData(await char.read());
    await this._queueCapabilityUpdate(sensorData);

    const readOnly = this._isReadOnly();
    this.log(`Repair complete: authenticated=${sensorData.authenticated} readOnly=${readOnly}`);

    return {
      authenticated: !readOnly,
      readOnly,
      readings: t('result_readings', {
        rpm: String(sensorData.rpm),
        temperature: sensorData.temperature.toFixed(1),
        humidity: sensorData.humidity.toFixed(1),
      }),
    };
  }

  /**
   * Find, connect and resolve the GATT database. Runs under the app-wide BLE
   * lock - everything in here needs exclusive use of the radio.
   * @param {string} uuid - Peripheral uuid stored at pairing time
   * @param {string} [address] - MAC address stored at pairing time
   */
  async _connectAndDiscover(uuid, address) {
    // After repeated failures, stop trusting Homey's advertisement cache: a
    // cached entry can outlive the peripheral and every connect against it
    // fails the same way, indefinitely, even once the fan is back in range
    const forceDiscover = this._forceRescan
      || this._consecutiveConnectFailures >= Constants.FORCE_DISCOVER_AFTER_FAILURES;
    if (forceDiscover) {
      this.log(`${this._consecutiveConnectFailures} consecutive failures - forcing a fresh scan`);
    }

    const advertisement = await this.homey.app.findAdvertisement(uuid, address, forceDiscover);

    if (!advertisement) {
      throw new Error('Device not found');
    }

    this._peripheral = await advertisement.connect();
    this.log('Connected to device');

    if (this._isDeleted) {
      // Deleted while the connect was pending - don't leave a live connection
      throw new Error('Device has been deleted');
    }

    // Set up disconnect handler. Capture the peripheral: a late event from
    // an already-torn-down peripheral must not null out a newer connection.
    const peripheral = this._peripheral;
    peripheral.once('disconnect', () => {
      if (this._peripheral !== peripheral) return;

      this._isConnected = false;
      this._peripheral = null;
      this._characteristics = {};
      this._notificationsSubscribed = false;
      this._deviceConfig = {};

      if (this._isDeleted) return;

      // Our own teardown (session recycle, shutdown) - the caller decides what
      // happens next, so don't race it with a reconnect from here
      if (this._intentionalDisconnect) return;

      // Notifications (if any) died with the connection. Reconnect promptly
      // instead of leaving up to a full POLL_INTERVAL of blindness. This was
      // a clean drop rather than a failed attempt, so retry from the shortest
      // delay instead of inheriting an old backoff.
      this.log('Device disconnected unexpectedly, scheduling reconnect');
      this._reconnectAttempts = 0;
      this._scheduleReconnect();
    });

    // Discover services and characteristics. The fans are slow here
    // (~16 s observed); nothing else may touch the radio meanwhile.
    await this._discoverServices();
  }

  /**
   * Reject if a promise has not settled in time.
   * Used to time-box work that holds the app-wide BLE lock, so one hung
   * peripheral cannot starve every other device of the radio. The underlying
   * operation is not cancellable - releasing the lock is the point.
   * @param {Promise} promise - The promise to time-box
   * @param {number} ms - Timeout in milliseconds
   * @param {string} label - Description used in the timeout error
   * @returns {Promise}
   */
  _withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = this.homey.setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
        ms,
      );
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timer) this.homey.clearTimeout(timer);
    });
  }

  /**
   * Resolve the peripheral's GATT database.
   *
   * Homey's BLE layer allows a fixed ~10 s for ServicesResolved; these fans
   * regularly need ~16 s, so one call can never succeed and the old code
   * failed every single connection here. Two things make it work:
   *
   *  - Retry on the OPEN connection. BlueZ keeps resolving in the background
   *    after the SDK gives up, so each retry is a fresh 10 s window against
   *    progress already made. The previous behaviour (throw -> teardown ->
   *    reconnect) discarded that progress and restarted the 16 s from zero,
   *    which is why it looped forever.
   *  - Stop as soon as the characteristics this driver actually uses are
   *    present, rather than insisting the full walk completes.
   */
  async _discoverServices() {
    const attempts = Constants.SERVICE_DISCOVERY_ATTEMPTS;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (!this._peripheral || this._peripheral.isConnected === false) {
        throw lastError || new Error('Device disconnected during service discovery');
      }

      try {
        this.log(`Discovering services and characteristics (attempt ${attempt}/${attempts})...`);
        await this._discoverServicesOnce();
        await this._cacheCharacteristics();
        this.log(`Service discovery complete (${(this._peripheral.services || []).length} services)`);
        return;
      } catch (err) {
        lastError = err;
        this.log(`Service discovery attempt ${attempt} failed: ${err.message}`);
      }

      // Partial results are still usable: the SDK timing out does not mean
      // nothing resolved. Check before spending another window.
      await this._cacheCharacteristics();
      if (this._hasRequiredCharacteristics()) {
        this.log('Required characteristics resolved despite the timeout, continuing');
        return;
      }
    }

    throw lastError;
  }

  /**
   * One discovery pass. Staged where the SDK allows it: fetching the service
   * handles is cheap, and discovering characteristics per service gives each
   * service its own timeout window instead of forcing the whole ~16 s walk
   * into a single 10 s budget.
   */
  async _discoverServicesOnce() {
    if (typeof this._peripheral.discoverServices !== 'function') {
      await this._peripheral.discoverAllServicesAndCharacteristics();
      return;
    }

    const services = await this._peripheral.discoverServices();
    this.log(`Found ${(services || []).length} services, discovering characteristics...`);

    for (const service of services || []) {
      if (!this._peripheral || this._peripheral.isConnected === false) {
        throw new Error('Device disconnected during service discovery');
      }
      if (typeof service.discoverCharacteristics !== 'function') continue;
      try {
        await service.discoverCharacteristics();
      } catch (err) {
        // One slow/unreadable service must not sink the whole connection -
        // the standard Device Information service in particular is not needed
        this.log(`Characteristics for service ${service.uuid} failed (continuing): ${err.message}`);
      }
    }
  }

  /**
   * Whether the characteristics this driver needs to function are cached.
   * DEVICE_STATUS is the one that matters: without it there are no readings
   * at all and the device would sit unavailable.
   * @returns {boolean}
   */
  _hasRequiredCharacteristics() {
    return Boolean(this._characteristics.deviceStatus);
  }

  /**
   * Cache characteristic references for faster access
   */
  async _cacheCharacteristics() {
    const charUuids = [
      { key: 'deviceStatus', uuid: Constants.DEVICE_STATUS },
      { key: 'auth', uuid: Constants.AUTH },
      { key: 'humidity', uuid: Constants.HUMIDITY },
      { key: 'lightVoc', uuid: Constants.LIGHT_VOC },
      { key: 'constantSpeed', uuid: Constants.CONSTANT_SPEED },
      { key: 'timer', uuid: Constants.TIMER },
      { key: 'airing', uuid: Constants.AIRING },
      { key: 'pause', uuid: Constants.PAUSE },
      { key: 'boost', uuid: Constants.BOOST },
      { key: 'temporarySpeed', uuid: Constants.TEMPORARY_SPEED },
    ];

    // Called after partial discovery too, so nothing here may assume the GATT
    // database is fully populated
    if (!this._peripheral) return;

    for (const service of this._peripheral.services || []) {
      for (const characteristic of service.characteristics || []) {
        const uuid = characteristic.uuid.toLowerCase().replace(/-/g, '');

        for (const charDef of charUuids) {
          if (uuid === charDef.uuid.toLowerCase().replace(/-/g, '')) {
            this._characteristics[charDef.key] = characteristic;
          }
        }
      }
    }
  }

  /**
   * Authenticate the current BLE session.
   * Fetching and authenticating are separate operations on the fan
   * (pyfreshintellivent: fetch_authentication_code reads, authenticate
   * writes) - a freshly fetched code must still be WRITTEN in this session,
   * otherwise the persistent connection stays unauthenticated and the fan
   * silently ignores every command until the next reconnect.
   */
  async _authenticate() {
    let authCode = this.getSetting('auth_code');

    if (!authCode || authCode === '00000000') {
      // No code yet, or only the not-in-pairing-mode marker: try to fetch.
      // This is also the recovery path for a device that was first paired
      // outside pairing mode - putting the fan in pairing mode and letting
      // it reconnect picks up a real code without re-pairing.
      this.log('No usable auth code stored, attempting to fetch...');
      await this._fetchAndStoreAuthCode();
      authCode = this.getSetting('auth_code');
      if (!authCode || authCode === '00000000') return;
    }

    try {
      await this._writeAuthCode(authCode);
    } catch (err) {
      this.error(`Authentication failed: ${err.message}`);
      // Try to fetch a new auth code, and if that produces a different
      // usable one, authenticate this session with it
      await this._fetchAndStoreAuthCode();
      const refreshed = this.getSetting('auth_code');
      if (refreshed && refreshed !== '00000000' && refreshed !== authCode) {
        await this._writeAuthCode(refreshed);
        return;
      }
      // A usable code exists but this session could not be authenticated.
      // Fail the connect: a persistent unauthenticated session would execute
      // every queued command with the fan silently ignoring it. The retry
      // path reconnects and authentication runs again.
      throw err;
    }
  }

  /**
   * While the device is read-only, keep watching for a real auth code.
   *
   * The code is only readable while the fan is in pairing mode, and this
   * app holds a persistent connection - so a fan put into pairing mode after
   * the app connected would otherwise stay read-only until someone restarted
   * the app, with every write silently rejected in the meantime. Retrying on
   * the live connection closes that gap.
   *
   * Must be called inside _withConnection().
   */
  async _retryAuthIfReadOnly() {
    if (this._isDeleted || !this._isReadOnly()) return;

    const now = Date.now();
    if (now - this._lastAuthRetry < Constants.AUTH_RETRY_INTERVAL) return;
    this._lastAuthRetry = now;

    await this._fetchAndStoreAuthCode();

    const authCode = this.getSetting('auth_code');
    if (!authCode || authCode === '00000000') return;

    // A stored code is not enough: this session must also be authenticated
    // with it, otherwise the fan keeps ignoring every command
    try {
      await this._writeAuthCode(authCode);
      this.log('Fan was in pairing mode - auth code picked up, control enabled');
      await this.unsetWarning().catch(this.error);
    } catch (err) {
      this.error(`Picked up an auth code but could not authenticate: ${err.message}`);
    }
  }

  /**
   * Write an auth code to the AUTH characteristic
   * @param {string} authCode - 8-character hex code
   */
  async _writeAuthCode(authCode) {
    const char = this._characteristics.auth;
    if (!char) {
      // Resolving here would let _authenticate() report success without any
      // auth write, silently leaving the session unauthenticated
      throw new Error('AUTH characteristic not found');
    }
    const authBuffer = Parser.encodeAuthCode(authCode);
    await char.write(authBuffer);
    this.log('Authentication successful');
  }

  /**
   * Check if auth code regeneration is allowed (cooldown check)
   * @returns {boolean} - True if regeneration is allowed
   */
  _canRegenerateAuthCode() {
    const now = Date.now();
    const timeSinceLastRegen = now - this._lastAuthRegenTime;
    return timeSinceLastRegen >= Constants.AUTH_REGEN_COOLDOWN;
  }

  /**
   * Fetch and store authentication code from device
   */
  async _fetchAndStoreAuthCode() {
    // Check cooldown before regenerating
    if (!this._canRegenerateAuthCode()) {
      const remainingSeconds = Math.ceil(
        (Constants.AUTH_REGEN_COOLDOWN - (Date.now() - this._lastAuthRegenTime)) / 1000,
      );
      this.log(`Auth code regeneration on cooldown. ${remainingSeconds}s remaining.`);
      return;
    }

    try {
      const char = this._characteristics.auth;
      if (char) {
        const data = await char.read();
        const authCode = Parser.parseAuthCode(data);

        if (!authCode) return;

        // The fan returns 00000000 when it is NOT in pairing mode
        // (pyfreshintellivent: "Fan was not in pairing mode"). Never let that
        // overwrite a previously stored real code - a transient auth failure
        // would otherwise permanently lock the device into read-only mode.
        const existingCode = this.getSetting('auth_code');
        if (authCode === '00000000' && existingCode && existingCode !== '00000000') {
          this.log('Fan not in pairing mode; keeping stored auth code');
          return;
        }

        // Nothing changed - skip the settings write. The read-only retry path
        // lands here every minute, and re-writing the same 00000000 marker
        // would churn settings (and the timeline) for no reason.
        if (authCode === existingCode) return;

        await this.setSettings({ auth_code: authCode });
        // Only a REAL code arms the regeneration cooldown. Storing the
        // 00000000 marker must not: it would block the pairing-mode recovery
        // path for the whole cooldown window right when the user is trying
        // to pair (reconnect attempts are already rate limited separately).
        if (authCode !== '00000000') {
          this._lastAuthRegenTime = Date.now();
        }
        this.log('Stored new auth code');
      }
    } catch (err) {
      this.error(`Failed to fetch auth code: ${err.message}`);
    }
  }

  /**
   * Execute a BLE operation with automatic connection handling.
   * The connection is persistent (no idle timeout) and stays open until
   * an unexpected disconnect, device deletion, or explicit disconnect call.
   * @param {Function} operation - The operation to execute
   * @param {number} [retries] - Extra attempts after the first. Defaults to
   *   MAX_RECONNECT_ATTEMPTS for user-initiated commands; the background poll
   *   passes 0 and leaves retrying to the reconnect scheduler.
   * @returns {*} - Result of the operation
   */
  async _withConnection(operation, retries = Constants.MAX_RECONNECT_ATTEMPTS) {
    // Queue operations to prevent concurrent BLE access. The stored queue tail
    // must never be a rejected promise: chaining .then() on a rejection would
    // skip every subsequent operation and replay the stale error forever.
    // Errors are delivered to the caller via `run`; the tail swallows them.
    const run = this._operationQueue
      .catch(() => {}) // previous operation's error was already delivered to its caller
      .then(() => this._executeWithRetry(operation, retries));
    this._operationQueue = run.catch(() => {});
    return run;
  }

  /**
   * Run one BLE operation, reconnecting on connection errors.
   * @param {Function} operation - The operation to execute
   * @param {number} retries - Extra attempts after the first
   * @returns {*} - Result of the operation
   */
  async _executeWithRetry(operation, retries = Constants.MAX_RECONNECT_ATTEMPTS) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this._isDeleted) {
        throw new Error('Device has been deleted');
      }
      try {
        await this._connect();
        const result = await operation();
        return result;
      } catch (err) {
        lastError = err;
        this.log(`Operation failed (attempt ${attempt + 1}): ${err.message}`);

        // Rate limiting is a deliberate back-off, not a transient fault.
        // Retrying burns the whole attempt budget inside the cooldown window
        // and turns one failure into four identical log lines.
        if (err.rateLimited) {
          throw err;
        }

        // If connection issue, try to reconnect
        if (!this._isConnected || err.message.includes('not connected') || err.message.includes('disconnected')) {
          await this._teardownConnection();

          if (attempt < retries) {
            // Exponential backoff. A fixed short delay turns a fan that is
            // briefly unreachable into a scan storm, and the scan churn from
            // several devices retrying in lockstep is itself enough to
            // destabilise Homey's BLE stack.
            const delay = Math.min(
              Constants.RECONNECT_DELAY * (2 ** attempt),
              Constants.MAX_RECONNECT_DELAY,
            );
            this.log(`Retrying in ${Math.round(delay / 1000)} seconds...`);
            await new Promise((resolve) => this.homey.setTimeout(resolve, delay));
          }
        } else {
          // Non-connection error, don't retry
          throw err;
        }
      }
    }

    throw lastError;
  }

  /**
   * Fetch sensor data from device
   */
  async _fetchSensorData() {
    // One fetch at a time. Overlapping fetches only ever queue up behind each
    // other anyway, and while disconnected they used to accumulate faster than
    // they drained.
    if (this._fetchInFlight || this._isDeleted) return;
    this._fetchInFlight = true;

    try {
      // Be the side that hangs up. The reconnect below re-establishes the
      // session immediately, so this costs one reconnect rather than a gap.
      await this._recycleSessionIfStale();

      // Single attempt: the reconnect scheduler owns retrying, with a backoff
      // that survives across calls. Retrying here as well would multiply the
      // scan churn and keep the rate limiter permanently armed.
      await this._withConnection(async () => {
        const char = this._characteristics.deviceStatus;
        if (!char) {
          this.log('Device status characteristic not found');
          return;
        }

        const data = await char.read();
        const sensorData = Parser.parseSensorData(data);

        this.log(`Sensor data: ${JSON.stringify(sensorData)}`);

        // Update capabilities
        await this._queueCapabilityUpdate(sensorData);

        // Cheap piggyback on the poll: pick up an auth code if the fan has
        // since been put into pairing mode
        await this._retryAuthIfReadOnly();
      }, 0);
    } catch (err) {
      this.error(`Failed to fetch sensor data: ${err.message}`);

      // Distinguish "this fan is unreachable" from "Homey's BLE scanner has
      // stopped working", which look identical from here but need completely
      // different things from the user
      const wedged = typeof this.homey.app.bleStackLooksWedged === 'function'
        && this.homey.app.bleStackLooksWedged();
      const reason = wedged ? 'errors.ble_unavailable' : 'errors.connection_failed';
      this.setUnavailable(this.homey.__(reason)).catch(this.error);

      // Keep trying, forever, at a decreasing rate. setAvailable() happens
      // again automatically on the first successful read.
      this._scheduleReconnect();
    } finally {
      this._fetchInFlight = false;
    }
  }

  /**
   * Serialize capability updates: the heartbeat poll and the notification
   * callback can otherwise interleave their awaited writes and leave a stale
   * value as the winner.
   * @param {object} sensorData - Parsed sensor data
   */
  async _queueCapabilityUpdate(sensorData) {
    const run = this._updateChain.then(() => this._updateCapabilities(sensorData));
    this._updateChain = run.catch(() => {});
    return run;
  }

  /**
   * Update capabilities based on sensor data
   * @param {object} sensorData - Parsed sensor data
   */
  async _updateCapabilities(sensorData) {
    // Capture the previous mode BEFORE writing the new one, otherwise the
    // change comparison below always sees the new value and never triggers.
    const previousMode = this.getCapabilityValue('intellivent_mode');

    if (sensorData.mode === null) {
      // Unknown mode byte - don't guess. Keep the previous mode/onoff state.
      this.log(`Unknown mode value from device: ${sensorData.modeRaw}`);
    } else {
      // Update on/off state
      const isOn = sensorData.mode !== 'off' && sensorData.mode !== 'pause';
      await this.setCapabilityValue('onoff', isOn).catch(this.error);

      // Update mode
      await this.setCapabilityValue('intellivent_mode', sensorData.mode).catch(this.error);
    }

    // Update live RPM sensor (read-only, actual measured value)
    await this.setCapabilityValue('measure_rpm', sensorData.rpm).catch(this.error);

    // Update temperature
    if (sensorData.temperature > 0) {
      await this.setCapabilityValue('measure_temperature', sensorData.temperature).catch(this.error);
    }

    // Update humidity
    if (sensorData.humidity > 0) {
      const currentHumidity = this.getCapabilityValue('measure_humidity');
      await this.setCapabilityValue('measure_humidity', sensorData.humidity).catch(this.error);

      // Trigger humidity changed flow
      if (currentHumidity !== sensorData.humidity) {
        await this.homey.flow.getDeviceTriggerCard('humidity_changed')
          .trigger(this, { humidity: sensorData.humidity })
          .catch(this.error);
      }
    }

    // Check for mode change and trigger flow (compare against the value
    // captured before the capability was updated)
    if (sensorData.mode !== null && previousMode !== sensorData.mode) {
      await this.homey.flow.getDeviceTriggerCard('mode_changed')
        .trigger(this, { mode: sensorData.mode })
        .catch(this.error);
    }

    // Device is available
    await this.setAvailable().catch(this.error);

    // Surface unauthenticated state: the fan silently ignores writes when not
    // authenticated, which would otherwise look like working control. The
    // read-only case (auth code 00000000) is the one that most needs a banner.
    if (!sensorData.authenticated) {
      const key = this._isReadOnly() ? 'errors.read_only' : 'errors.not_authenticated';
      await this.setWarning(this.homey.__(key)).catch(this.error);
    } else {
      await this.unsetWarning().catch(this.error);
    }
  }

  /**
   * Set device mode
   * @param {string} mode - Mode to set
   */
  async setMode(mode) {
    this._checkWriteAccess();
    try {
      await this._withConnection(async () => {
        switch (mode) {
          case 'off':
          case 'pause':
            await this._setPause(true, 0);
            break;
          case 'constant_speed':
            await this._setConstantSpeed(true, this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM);
            break;
          case 'humidity': {
            const sensitivity = parseInt(this.getCapabilityValue('intellivent_humidity_sensitivity') || '2', 10);
            await this._setHumidity(true, sensitivity, this._humidityRpm());
            break;
          }
          case 'light': {
            // The light/VOC characteristic is written as one payload -
            // unchanged fields come from the device's own cached values
            const p = this._lightVocParams({ lightEnabled: true });
            await this._setLightVoc(p.lightEnabled, p.lightDetection, p.vocEnabled, p.vocDetection);
            break;
          }
          case 'voc': {
            const p = this._lightVocParams({ vocEnabled: true });
            await this._setLightVoc(p.lightEnabled, p.lightDetection, p.vocEnabled, p.vocDetection);
            break;
          }
          case 'boost':
            await this._setBoost(true, Constants.MAX_RPM, 15);
            break;
          case 'airing':
            await this._setAiring(true, 30, this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM);
            break;
          case 'timer':
            await this._setTimer(30, false, 0, this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM);
            break;
          default:
            throw new Error(`Unknown mode: ${mode}`);
        }
      });

      // Keep the enable toggles in step with what the mode write turned on,
      // so later shared-payload writes don't rebuild from a stale 'false'
      if (mode === 'humidity') {
        await this.setCapabilityValue('intellivent_humidity_enabled', true).catch(this.error);
      } else if (mode === 'light') {
        await this.setCapabilityValue('intellivent_light_enabled', true).catch(this.error);
      } else if (mode === 'voc') {
        await this.setCapabilityValue('intellivent_voc_enabled', true).catch(this.error);
      }

      // Update capability and fire the mode_changed trigger for
      // Homey-originated changes (the device-report path won't see a change
      // after this optimistic update)
      await this._setModeCapability(mode);
    } catch (err) {
      this.error(`Failed to set mode: ${err.message}`);
      throw err;
    }
  }

  /**
   * Set the mode capability and fire mode_changed if it actually changed
   * @param {string} mode - The new mode
   */
  async _setModeCapability(mode) {
    const previous = this.getCapabilityValue('intellivent_mode');
    await this.setCapabilityValue('intellivent_mode', mode);
    if (previous !== mode) {
      await this.homey.flow.getDeviceTriggerCard('mode_changed')
        .trigger(this, { mode })
        .catch(this.error);
    }
  }

  /**
   * The RPM to use for humidity-mode writes: the device's own configured
   * humidity RPM when known, otherwise the RPM capability
   * @returns {number}
   */
  _humidityRpm() {
    return this._deviceConfig.humidityRpm
      ?? (this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM);
  }

  /**
   * Assemble the full light/VOC payload for a partial change. The
   * characteristic is written as one payload, so unchanged fields must come
   * from the device's own values (cached at readback), falling back to the
   * capabilities only when no readback has succeeded yet.
   * @param {object} overrides - Fields the caller is deliberately changing
   * @returns {object} - {lightEnabled, lightDetection, vocEnabled, vocDetection}
   */
  _lightVocParams(overrides = {}) {
    return {
      lightEnabled: overrides.lightEnabled
        ?? this._deviceConfig.lightEnabled
        ?? (this.getCapabilityValue('intellivent_light_enabled') === true),
      lightDetection: overrides.lightDetection
        ?? this._deviceConfig.lightDetectionRaw
        ?? parseInt(this.getCapabilityValue('intellivent_light_sensitivity') || '2', 10),
      vocEnabled: overrides.vocEnabled
        ?? this._deviceConfig.vocEnabled
        ?? (this.getCapabilityValue('intellivent_voc_enabled') === true),
      vocDetection: overrides.vocDetection
        ?? this._deviceConfig.vocDetectionRaw
        ?? parseInt(this.getCapabilityValue('intellivent_voc_sensitivity') || '2', 10),
    };
  }

  /**
   * Set fan RPM
   * @param {number} rpm - RPM value
   */
  async setRpm(rpm) {
    this._checkWriteAccess();
    await this._setTemporarySpeed(rpm);
    await this.setCapabilityValue('intellivent_rpm', rpm);
  }

  /**
   * Start boost mode
   * @param {number} duration - Duration in minutes
   * @param {number} rpm - RPM value
   */
  async startBoost(duration, rpm) {
    this._checkWriteAccess();
    await this._withConnection(async () => {
      await this._setBoost(true, rpm, duration);
    });
    await this._setModeCapability('boost');
  }

  /**
   * Configure humidity detection
   * @param {boolean} enabled - Enable humidity detection
   * @param {number} sensitivity - Sensitivity level (0=low, 1=medium, 2=high)
   * @param {number} rpm - Fan speed when humidity detected
   */
  async configureHumidity(enabled, sensitivity, rpm) {
    this._checkWriteAccess();
    await this._withConnection(async () => {
      await this._setHumidity(enabled, sensitivity, rpm);
    });

    // Update capabilities
    await this.setCapabilityValue('intellivent_humidity_enabled', enabled);
    await this.setCapabilityValue('intellivent_humidity_sensitivity', String(sensitivity));

    // If enabled, update mode
    if (enabled) {
      await this._setModeCapability('humidity');
    }

    this.log(`Humidity detection configured: enabled=${enabled}, sensitivity=${sensitivity}, rpm=${rpm}`);
  }

  /**
   * Set humidity detection enabled/disabled
   * @param {boolean} enabled - Enable or disable humidity detection
   */
  async setHumidityEnabled(enabled) {
    this._checkWriteAccess();
    const sensitivity = parseInt(this.getCapabilityValue('intellivent_humidity_sensitivity') || '2', 10);

    await this._withConnection(async () => {
      await this._setHumidity(enabled, sensitivity, this._humidityRpm());
    });

    await this.setCapabilityValue('intellivent_humidity_enabled', enabled);

    this.log(`Humidity detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set humidity sensitivity
   * @param {number} sensitivity - Sensitivity level (0=low, 1=medium, 2=high)
   */
  async setHumiditySensitivity(sensitivity) {
    this._checkWriteAccess();
    const enabled = this.getCapabilityValue('intellivent_humidity_enabled') !== false;

    await this._withConnection(async () => {
      await this._setHumidity(enabled, sensitivity, this._humidityRpm());
    });

    await this.setCapabilityValue('intellivent_humidity_sensitivity', String(sensitivity));

    this.log(`Humidity sensitivity set to ${sensitivity}`);
  }

  /**
   * Set light detection enabled/disabled
   * @param {boolean} enabled - Enable or disable light detection
   */
  async setLightEnabled(enabled) {
    this._checkWriteAccess();
    await this._withConnection(async () => {
      // Assemble the payload inside the connected context so it uses the
      // values read back from the device, not a pre-connect snapshot
      const p = this._lightVocParams({ lightEnabled: enabled });
      await this._setLightVoc(p.lightEnabled, p.lightDetection, p.vocEnabled, p.vocDetection);
    });

    await this.setCapabilityValue('intellivent_light_enabled', enabled);

    this.log(`Light detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set light sensitivity
   * @param {number} sensitivity - Sensitivity level (0=low, 1=medium, 2=high)
   */
  async setLightSensitivity(sensitivity) {
    this._checkWriteAccess();
    await this._withConnection(async () => {
      // Assemble the payload inside the connected context so it uses the
      // values read back from the device, not a pre-connect snapshot
      const p = this._lightVocParams({ lightDetection: sensitivity });
      await this._setLightVoc(p.lightEnabled, p.lightDetection, p.vocEnabled, p.vocDetection);
    });

    await this.setCapabilityValue('intellivent_light_sensitivity', String(sensitivity));

    this.log(`Light sensitivity set to ${sensitivity}`);
  }

  /**
   * Set VOC (smell) detection enabled/disabled
   * @param {boolean} enabled - Enable or disable VOC detection
   */
  async setVocEnabled(enabled) {
    this._checkWriteAccess();
    await this._withConnection(async () => {
      // Assemble the payload inside the connected context so it uses the
      // values read back from the device, not a pre-connect snapshot
      const p = this._lightVocParams({ vocEnabled: enabled });
      await this._setLightVoc(p.lightEnabled, p.lightDetection, p.vocEnabled, p.vocDetection);
    });

    await this.setCapabilityValue('intellivent_voc_enabled', enabled);

    this.log(`VOC detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set VOC (smell) sensitivity
   * @param {number} sensitivity - Sensitivity level (0=low, 1=medium, 2=high)
   */
  async setVocSensitivity(sensitivity) {
    this._checkWriteAccess();
    await this._withConnection(async () => {
      // Assemble the payload inside the connected context so it uses the
      // values read back from the device, not a pre-connect snapshot
      const p = this._lightVocParams({ vocDetection: sensitivity });
      await this._setLightVoc(p.lightEnabled, p.lightDetection, p.vocEnabled, p.vocDetection);
    });

    await this.setCapabilityValue('intellivent_voc_sensitivity', String(sensitivity));

    this.log(`VOC sensitivity set to ${sensitivity}`);
  }

  // BLE write operations

  async _setConstantSpeed(enabled, rpm) {
    const char = this._characteristics.constantSpeed;
    if (!char) throw new Error('Constant speed characteristic not found');
    const data = Parser.encodeConstantSpeed(enabled, rpm);
    await char.write(data);
  }

  async _setHumidity(enabled, detection, rpm) {
    const char = this._characteristics.humidity;
    if (!char) throw new Error('Humidity characteristic not found');
    const data = Parser.encodeHumidity(enabled, detection, rpm);
    await char.write(data);
    // The write succeeded - the device now holds this value
    this._deviceConfig.humidityRpm = Parser.validateRpm(rpm);
  }

  async _setLightVoc(lightEnabled, lightDetection, vocEnabled, vocDetection) {
    const char = this._characteristics.lightVoc;
    if (!char) throw new Error('Light/VOC characteristic not found');
    const data = Parser.encodeLightVoc(lightEnabled, lightDetection, vocEnabled, vocDetection);
    await char.write(data);
    // The write succeeded - the device now holds these values
    this._deviceConfig.lightEnabled = Boolean(lightEnabled);
    this._deviceConfig.lightDetectionRaw = Parser.validateDetection(lightDetection);
    this._deviceConfig.vocEnabled = Boolean(vocEnabled);
    this._deviceConfig.vocDetectionRaw = Parser.validateDetection(vocDetection);
  }

  async _setTimer(duration, delayEnabled, delayMinutes, rpm) {
    const char = this._characteristics.timer;
    if (!char) throw new Error('Timer characteristic not found');
    const data = Parser.encodeTimer(duration, delayEnabled, delayMinutes, rpm);
    await char.write(data);
  }

  async _setAiring(enabled, minutes, rpm) {
    const char = this._characteristics.airing;
    if (!char) throw new Error('Airing characteristic not found');
    const data = Parser.encodeAiring(enabled, minutes, rpm);
    await char.write(data);
  }

  async _setPause(enabled, duration) {
    const char = this._characteristics.pause;
    if (!char) throw new Error('Pause characteristic not found');
    const data = Parser.encodePause(enabled, duration);
    await char.write(data);
  }

  async _setBoost(enabled, rpm, duration) {
    const char = this._characteristics.boost;
    if (!char) throw new Error('Boost characteristic not found');
    const data = Parser.encodeBoost(enabled, rpm, duration);
    await char.write(data);
  }

  async _setTemporarySpeed(rpm) {
    await this._withConnection(async () => {
      const char = this._characteristics.temporarySpeed;
      if (!char) throw new Error('Temporary speed characteristic not found');
      const data = Parser.encodeTemporarySpeed(rpm);
      await char.write(data);
    });
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Intellivent Sky device has been added');

    // Fetch initial sensor data
    await this._fetchSensorData();
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Intellivent Sky device settings were changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name) {
    this.log(`Intellivent Sky device was renamed to ${name}`);
  }

  /**
   * onUninit is called when the app stops: restart, update, uninstall, or
   * Homey shutting down.
   *
   * Without this, every one of those left the GATT link open from Homey's
   * side. The fan goes on believing it has a session with a process that no
   * longer exists, and the eventual teardown is peripheral-initiated - which
   * per athombv/homey-apps-sdk-issues#454 is exactly what leaves Homey's BLE
   * manager unable to reconnect until the whole Homey is rebooted. Every app
   * update was quietly seeding the failure it then had to recover from.
   */
  async onUninit() {
    this.log('Intellivent Sky device is shutting down, releasing BLE session');

    // Stop anything that might start new BLE work mid-teardown
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    this._cancelScheduledReconnect();
    this._isDeleted = true; // gates reconnects scheduled from the disconnect handler

    await this._disconnect(true).catch((err) => this.error(`Teardown failed: ${err.message}`));
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    this.log('Intellivent Sky device has been deleted');
    this._isDeleted = true;

    // Stop polling
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }

    // A pending reconnect would otherwise fire against a deleted device
    this._cancelScheduledReconnect();

    // Disconnect (also unsubscribes from notifications)
    await this._disconnect(true);
  }

}

module.exports = IntelliventSkyDevice;
