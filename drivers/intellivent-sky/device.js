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
    this._operationQueue = Promise.resolve();
    this._updateChain = Promise.resolve();
    this._isDeleted = false;
    // Bumped by every connect attempt and every teardown. The connect is
    // time-boxed but not cancellable, so an attempt that was abandoned can
    // still finish later - it compares its number against this one and backs
    // off instead of taking over the device's connection.
    this._connectGen = 0;
    // The fan's own 'authenticated' flag from its last status report. null
    // means unknown (no report since the session was (re)authenticated).
    this._lastAuthenticated = null;
    // When the current connection was established (0 = not connected), used
    // to tell a stable link from one that keeps dropping right away
    this._connectedAt = 0;
    // Last warning/unavailable reason applied, so the poll only calls the
    // Homey API when something actually changed (undefined = not yet applied)
    this._warningKey = undefined;
    this._unavailableKey = undefined;
    this._lastSensorLog = null;

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
    await this._migrateAuthCode();

    // humidity_changed fires relative to this reading. Seeded from the stored
    // value so an app restart does not fire it for an unchanged reading.
    this._humidityTriggerBaseline = this.getCapabilityValue('measure_humidity');

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
    return this._getAuthCode() === '00000000';
  }

  /**
   * The fan's auth code. Kept in the device store; the settings page only
   * shows a masked version, so the code is not on display to everyone with
   * access to the device.
   * @returns {string|undefined}
   */
  _getAuthCode() {
    return this.getStoreValue('authCode') ?? this.getSetting('auth_code');
  }

  /**
   * Store the fan's auth code and show its masked form in settings
   * @param {string} authCode - 8 hex characters
   */
  async _setAuthCode(authCode) {
    await this.setStoreValue('authCode', authCode);
    await this.setSettings({ auth_code: IntelliventSkyDevice._maskAuthCode(authCode) })
      .catch(this.error);
  }

  /**
   * The settings label for an auth code. The read-only marker stays visible
   * because the setting's hint explains what it means.
   * @param {string} authCode - Auth code
   * @returns {string}
   */
  static _maskAuthCode(authCode) {
    if (!authCode) return '';
    return authCode === '00000000' ? authCode : '••••••••';
  }

  /**
   * Devices paired before 0.4.7 kept the plain auth code in settings. Move it
   * to the store once and mask the setting.
   */
  async _migrateAuthCode() {
    if (this.getStoreValue('authCode') !== undefined && this.getStoreValue('authCode') !== null) return;
    const legacy = this.getSetting('auth_code');
    if (typeof legacy !== 'string' || !/^[0-9a-f]{8}$/i.test(legacy)) return;
    try {
      await this._setAuthCode(legacy.toLowerCase());
    } catch (err) {
      // Nothing lost: _getAuthCode() still falls back to the setting
      this.error(`Could not migrate auth code: ${err.message}`);
    }
  }

  /**
   * Throw an error if the device is in read-only mode
   * @throws {Error} - If device is read-only
   */
  _checkWriteAccess() {
    if (this._isReadOnly()) {
      throw this._userError(this.homey.__('errors.read_only'));
    }
    // The fan itself reports this session as unauthenticated: it would accept
    // the write and silently ignore it, while the tile showed the new value
    if (this._lastAuthenticated === false) {
      throw this._userError(this.homey.__('errors.not_authenticated'));
    }
  }

  /**
   * Build an error whose message is already fit to show the user
   * @param {string} message - Translated message
   * @returns {Error}
   */
  _userError(message) {
    const err = new Error(message);
    err.userFacing = true;
    return err;
  }

  /**
   * Run a user-initiated command (tile, Flow card, repair) and turn whatever
   * goes wrong into a translated message the user can act on. The technical
   * error stays in the log.
   * @param {Function} command - The command to run
   * @returns {*} - Result of the command
   */
  async runUserCommand(command) {
    try {
      return await command();
    } catch (err) {
      if (err && err.userFacing) throw err;

      this.error('Command failed:', err && err.message);
      if (err && err.commandTimeout) {
        throw this._userError(this.homey.__('errors.command_timeout'));
      }
      if (err && err.rateLimited) {
        throw this._userError(this.homey.__('errors.rate_limited', {
          seconds: String(err.retryAfterSeconds),
        }));
      }
      // A failed connection is torn down before the error reaches us
      const key = this._isConnected ? 'errors.write_failed' : 'errors.connection_failed';
      throw this._userError(this.homey.__(key));
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
    // Every listener runs through runUserCommand so the tile shows a readable error
    const listen = (capability, listener) => this.registerCapabilityListener(
      capability,
      (value, opts) => this.runUserCommand(() => listener(value, opts)),
    );

    // On/Off capability
    listen('onoff', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting onoff to ${value}`);
      await this.setOnOff(value);
    });

    // Mode capability
    listen('intellivent_mode', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting mode to ${value}`);
      await this.setMode(value);
    });

    // RPM capability
    listen('intellivent_rpm', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting RPM to ${value}`);
      await this.setRpm(value);
    });

    // Humidity enabled capability
    listen('intellivent_humidity_enabled', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting humidity enabled to ${value}`);
      await this.setHumidityEnabled(value);
    });

    // Humidity sensitivity capability
    listen('intellivent_humidity_sensitivity', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting humidity sensitivity to ${value}`);
      await this.setHumiditySensitivity(parseInt(value, 10));
    });

    // Light enabled capability
    listen('intellivent_light_enabled', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting light enabled to ${value}`);
      await this.setLightEnabled(value);
    });

    // Light sensitivity capability
    listen('intellivent_light_sensitivity', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting light sensitivity to ${value}`);
      await this.setLightSensitivity(parseInt(value, 10));
    });

    // VOC enabled capability
    listen('intellivent_voc_enabled', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting VOC enabled to ${value}`);
      await this.setVocEnabled(value);
    });

    // VOC sensitivity capability
    listen('intellivent_voc_sensitivity', async (value) => {
      this._checkWriteAccess();
      this.log(`Setting VOC sensitivity to ${value}`);
      await this.setVocSensitivity(parseInt(value, 10));
    });

    // Boost button - one tap, using the speed/duration from device settings
    listen('intellivent_boost', async () => {
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
   * Whether the current connection has lasted long enough to count as a
   * healthy link rather than one that keeps dropping
   * @returns {boolean}
   */
  _isStableConnection() {
    return this._isConnected
      && this._connectedAt > 0
      && Date.now() - this._connectedAt >= Constants.STABLE_CONNECTION_TIME;
  }

  /**
   * Called after each successful poll: once the link has been up for
   * STABLE_CONNECTION_TIME, forget every accumulated penalty, so the next
   * isolated blip retries in 5 s rather than resuming a long backoff.
   */
  _noteStableConnection() {
    if (this._reconnectAttempts === 0 && this._connectionFailures.length === 0) return;
    if (this._isStableConnection()) this._resetBackoff();
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
      err.retryAfterSeconds = remainingSeconds;
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
      err.retryAfterSeconds = cooldownSeconds;
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
    const gen = ++this._connectGen;

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
        this._connectAndDiscover(uuid, address, gen),
        Constants.CONNECT_TIMEOUT,
        'BLE connect/discovery',
      ));

      if (this._isDeleted) {
        throw new Error('Device has been deleted');
      }

      // Cache characteristics
      await this._cacheCharacteristics();

      // Without the status characteristic the device would sit "connected"
      // with no readings, and never be marked unavailable
      if (!this._hasRequiredCharacteristics()) {
        throw new Error('Device status characteristic not found');
      }

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
      this._connectedAt = Date.now();

      // Connected again. The reconnect backoff is only forgotten once the
      // link has proven stable (see _noteStableConnection) - a fan that
      // connects and drops straight away must keep backing off.
      this._consecutiveConnectFailures = 0;
      this._extendedCooldownUntil = 0;
      this._cancelScheduledReconnect();

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
        const humidity = Parser.parseHumidity(await this._gattRead(humidityChar, 'Humidity'));
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
        const lightVoc = Parser.parseLightVoc(await this._gattRead(lightVocChar, 'Light/VOC'));
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
        const constantSpeed = Parser.parseConstantSpeed(await this._gattRead(constantSpeedChar, 'Constant speed'));
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

    try {
      await this._syncDeviceInfo();
    } catch (err) {
      this.log(`Device info readback failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Read firmware and hardware version from the standard Device Information
   * service into the settings labels, which otherwise only ever said
   * "Unknown". Written only when a value changed.
   */
  async _syncDeviceInfo() {
    const fields = [
      { key: 'firmwareVersion', setting: 'firmware_version', label: 'Firmware version' },
      { key: 'hardwareVersion', setting: 'hardware_version', label: 'Hardware version' },
    ];
    const changed = {};
    for (const { key, setting, label } of fields) {
      const char = this._characteristics[key];
      if (!char) continue;
      const value = Parser.parseString(await this._gattRead(char, label));
      if (value && value !== this.getSetting(setting)) {
        changed[setting] = value;
        await this.setStoreValue(key, value).catch(this.error);
      }
    }
    if (Object.keys(changed).length > 0) {
      this.log(`Device info: ${JSON.stringify(changed)}`);
      await this.setSettings(changed).catch(this.error);
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
    this._resetConnectionState();

    if (peripheral) {
      try {
        await this._withTimeout(peripheral.disconnect(), Constants.GATT_TIMEOUT, 'BLE disconnect');
      } catch (err) {
        // Peripheral may already be gone - nothing to clean up
      }
    }
  }

  /**
   * Forget everything tied to the current connection. Also abandons any
   * connect attempt still in flight (see _connectGen).
   */
  _resetConnectionState() {
    this._connectGen += 1;
    this._isConnected = false;
    this._connectedAt = 0;
    this._peripheral = null;
    this._characteristics = {};
    this._notificationsSubscribed = false;
    // Cached device config is only trusted for the connection it was read on
    this._deviceConfig = {};
    // A new session authenticates again; its state is unknown until reported
    this._lastAuthenticated = null;
  }

  /**
   * Subscribe to BLE notifications on DEVICE_STATUS characteristic.
   * Falls back to polling if the characteristic does not support notifications.
   */
  async _subscribeToNotifications() {
    const char = this._characteristics.deviceStatus;
    if (!char) return;

    try {
      await this._withTimeout(char.subscribeToNotifications(async (data) => {
        try {
          const sensorData = Parser.parseSensorData(data);
          await this._queueCapabilityUpdate(sensorData);
        } catch (err) {
          this.error(`Notification parse error: ${err.message}`);
        }
      }), Constants.GATT_TIMEOUT, 'Subscribe');
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
   * Disconnect from the BLE device on purpose (repair, shutdown, deletion)
   */
  async _disconnect() {
    if (this._peripheral) {
      // Tell the 'disconnect' handler this teardown is ours, so it does not
      // treat it as a surprise drop and schedule a competing reconnect
      this._intentionalDisconnect = true;
      // Unsubscribe from notifications before disconnecting
      if (this._notificationsSubscribed) {
        const char = this._characteristics.deviceStatus;
        if (char) {
          try {
            await this._withTimeout(
              char.unsubscribeFromNotifications(),
              Constants.GATT_TIMEOUT,
              'Unsubscribe',
            );
          } catch (err) {
            this.log(`Error unsubscribing: ${err.message}`);
          }
        }
        this._notificationsSubscribed = false;
      }

      const peripheral = this._peripheral;
      try {
        await this._withTimeout(peripheral.disconnect(), Constants.GATT_TIMEOUT, 'BLE disconnect');
        this.log('Disconnected from device');
      } catch (err) {
        this.log(`Error disconnecting: ${err.message}`);
      }
      this._resetConnectionState();
      this._intentionalDisconnect = false;
    } else {
      // Nothing connected, but a connect may still be in flight
      this._connectGen += 1;
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
      .then(() => this.runUserCommand(() => this._repairSequence(onProgress)));
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
    await this._disconnect().catch(() => {});

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
      throw this._userError(t('error_no_status_characteristic'));
    }

    let sensorData = Parser.parseSensorData(await this._gattRead(char, 'Status'));
    await this._queueCapabilityUpdate(sensorData);

    // The connect only fetches a code when none is stored, so a stored but
    // stale code survives it. Ask the fan directly - it hands out the current
    // code while in pairing mode - past the cooldown, since the user asked.
    if (!sensorData.authenticated) {
      onProgress(t('progress_auth'));
      this._lastAuthRegenTime = 0;
      await this._refreshAuthentication();
      sensorData = Parser.parseSensorData(await this._gattRead(char, 'Status'));
      await this._queueCapabilityUpdate(sensorData);
    }

    // Report what the fan says, not whether a code is stored: a stored code
    // the fan does not accept is not control
    const { authenticated } = sensorData;
    const readOnly = this._isReadOnly();
    this.log(`Repair complete: authenticated=${authenticated} readOnly=${readOnly}`);

    return {
      authenticated,
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
   * @param {number} gen - This attempt's connect generation
   */
  async _connectAndDiscover(uuid, address, gen) {
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

    const peripheral = await advertisement.connect();

    if (this._isDeleted || gen !== this._connectGen) {
      // Deleted, timed out or superseded while connect() was pending. This
      // link belongs to nobody now: release it instead of overwriting the
      // device's current connection, and never leave it holding the fan's
      // only BLE slot.
      await this._withTimeout(peripheral.disconnect(), Constants.GATT_TIMEOUT, 'BLE disconnect')
        .catch(() => {});
      throw new Error(this._isDeleted ? 'Device has been deleted' : 'Connection attempt abandoned');
    }

    this._peripheral = peripheral;
    this.log('Connected to device');

    // Set up disconnect handler. Capture the peripheral: a late event from
    // an already-torn-down peripheral must not null out a newer connection.
    peripheral.once('disconnect', () => {
      if (this._peripheral !== peripheral) return;

      const wasStable = this._isStableConnection();
      this._resetConnectionState();

      if (this._isDeleted) return;

      // Our own teardown (session recycle, shutdown) - the caller decides what
      // happens next, so don't race it with a reconnect from here
      if (this._intentionalDisconnect) return;

      // Notifications (if any) died with the connection. Reconnect promptly
      // instead of leaving up to a full POLL_INTERVAL of blindness. A drop
      // after a stable connection retries from the shortest delay; a link
      // that dropped soon after connecting keeps its backoff (and counts
      // towards the rate limiter), so a flapping fan cannot turn into a scan
      // every few seconds.
      this.log(`Device disconnected unexpectedly (${wasStable ? 'stable' : 'short-lived'} link), scheduling reconnect`);
      if (wasStable) {
        this._reconnectAttempts = 0;
      } else {
        this._recordConnectionFailure();
      }
      this._scheduleReconnect();
    });

    // Discover services and characteristics. The fans are slow here
    // (~16 s observed); nothing else may touch the radio meanwhile.
    await this._discoverServices(gen);
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
        () => {
          const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
          err.timedOut = true;
          reject(err);
        },
        ms,
      );
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timer) this.homey.clearTimeout(timer);
    });
  }

  /**
   * Read a characteristic, time-boxed (see GATT_TIMEOUT). A read that times
   * out is flagged as a lost link so the caller's retry path reconnects.
   * @param {BleCharacteristic} char - Characteristic to read
   * @param {string} label - Name used in errors
   * @returns {Promise<Buffer>}
   */
  async _gattRead(char, label) {
    try {
      return await this._withTimeout(char.read(), Constants.GATT_TIMEOUT, `${label} read`);
    } catch (err) {
      if (err.timedOut) err.connectionLost = true;
      throw err;
    }
  }

  /**
   * Write a characteristic, time-boxed (see GATT_TIMEOUT)
   * @param {BleCharacteristic} char - Characteristic to write
   * @param {Buffer} data - Payload
   * @param {string} label - Name used in errors
   */
  async _gattWrite(char, data, label) {
    try {
      await this._withTimeout(char.write(data), Constants.GATT_TIMEOUT, `${label} write`);
    } catch (err) {
      if (err.timedOut) err.connectionLost = true;
      throw err;
    }
  }

  /**
   * Whether an error means the link is gone and must be rebuilt, as opposed
   * to a command the fan refused on a healthy link
   * @param {Error} err - The error
   * @returns {boolean}
   */
  _isConnectionError(err) {
    if (!this._isConnected || (err && err.connectionLost)) return true;
    // Homey's wording varies by firmware ('Not connected', 'Peripheral
    // disconnected', ...), so match loosely and case-insensitively
    return /not connected|disconnected/i.test(String(err && err.message));
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
   *
   * @param {number} gen - Connect generation this discovery belongs to
   */
  async _discoverServices(gen) {
    const attempts = Constants.SERVICE_DISCOVERY_ATTEMPTS;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      this._assertCurrentAttempt(gen);
      if (!this._peripheral || this._peripheral.isConnected === false) {
        throw lastError || new Error('Device disconnected during service discovery');
      }

      try {
        this.log(`Discovering services and characteristics (attempt ${attempt}/${attempts})...`);
        await this._discoverServicesOnce(gen);
        this._assertCurrentAttempt(gen);
        await this._cacheCharacteristics();
        this.log(`Service discovery complete (${(this._peripheral.services || []).length} services)`);
        return;
      } catch (err) {
        lastError = err;
        this.log(`Service discovery attempt ${attempt} failed: ${err.message}`);
      }

      // Partial results are still usable: the SDK timing out does not mean
      // nothing resolved. Check before spending another window.
      this._assertCurrentAttempt(gen);
      await this._cacheCharacteristics();
      if (this._hasRequiredCharacteristics()) {
        this.log('Required characteristics resolved despite the timeout, continuing');
        return;
      }
    }

    throw lastError;
  }

  /**
   * Throw when a connect attempt has been abandoned (timed out, torn down,
   * superseded). Its discovery must not touch a newer connection.
   * @param {number} gen - The attempt's connect generation
   */
  _assertCurrentAttempt(gen) {
    if (gen !== this._connectGen) {
      throw new Error('Connection attempt abandoned');
    }
  }

  /**
   * One discovery pass. Staged where the SDK allows it: fetching the service
   * handles is cheap, and discovering characteristics per service gives each
   * service its own timeout window instead of forcing the whole ~16 s walk
   * into a single 10 s budget.
   * @param {number} gen - Connect generation this pass belongs to
   */
  async _discoverServicesOnce(gen) {
    if (typeof this._peripheral.discoverServices !== 'function') {
      await this._peripheral.discoverAllServicesAndCharacteristics();
      return;
    }

    const services = await this._peripheral.discoverServices();
    this.log(`Found ${(services || []).length} services, discovering characteristics...`);

    for (const service of services || []) {
      this._assertCurrentAttempt(gen);
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
      { key: 'firmwareVersion', uuid: Constants.FIRMWARE_VERSION },
      { key: 'hardwareVersion', uuid: Constants.HARDWARE_VERSION },
    ];

    // Called after partial discovery too, so nothing here may assume the GATT
    // database is fully populated
    if (!this._peripheral) return;

    for (const service of this._peripheral.services || []) {
      for (const characteristic of service.characteristics || []) {
        for (const charDef of charUuids) {
          // Standard characteristics may be reported in 16-bit short form
          if (Parser.uuidMatches(characteristic.uuid, charDef.uuid)) {
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
    let authCode = this._getAuthCode();

    if (!authCode || authCode === '00000000') {
      // No code yet, or only the not-in-pairing-mode marker: try to fetch.
      // This is also the recovery path for a device that was first paired
      // outside pairing mode - putting the fan in pairing mode and letting
      // it reconnect picks up a real code without re-pairing.
      this.log('No usable auth code stored, attempting to fetch...');
      await this._fetchAndStoreAuthCode();
      authCode = this._getAuthCode();
      if (!authCode || authCode === '00000000') return;
    }

    try {
      await this._writeAuthCode(authCode);
    } catch (err) {
      this.error(`Authentication failed: ${err.message}`);
      // Try to fetch a new auth code, and if that produces a different
      // usable one, authenticate this session with it
      await this._fetchAndStoreAuthCode();
      const refreshed = this._getAuthCode();
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
   * While the device is read-only, or the fan reports this session as
   * unauthenticated, keep watching for a new auth code.
   *
   * The code is only readable while the fan is in pairing mode, and this
   * app holds a persistent connection - so a fan put into pairing mode after
   * the app connected would otherwise stay read-only (or stuck on a stale
   * code) until someone restarted the app, with every write silently
   * rejected in the meantime. Retrying on the live connection closes that gap.
   *
   * Must be called inside _withConnection().
   */
  async _retryAuthIfNeeded() {
    if (this._isDeleted) return;
    if (!this._isReadOnly() && this._lastAuthenticated !== false) return;

    const now = Date.now();
    if (now - this._lastAuthRetry < Constants.AUTH_RETRY_INTERVAL) return;
    this._lastAuthRetry = now;

    // Only act on a code that differs from the stored one: re-writing a
    // stale code every minute changes nothing on the fan
    if (await this._refreshAuthentication({ onlyIfChanged: true })) {
      // The warning follows the fan's next status report
      this.log('Fan was in pairing mode - auth code picked up, control enabled');
    }
  }

  /**
   * Read the auth code from the fan and authenticate this session with it.
   * A stored code can be well-formed yet stale (fan reset or re-paired): the
   * fan then accepts the auth write but reports the session unauthenticated,
   * and only a fresh read - possible while the fan is in pairing mode - fixes
   * that.
   * @param {object} [options]
   * @param {boolean} [options.onlyIfChanged] - Skip the write when the fan
   *   did not hand out a different code than the one already stored
   * @returns {Promise<boolean>} - True when an auth write went through
   */
  async _refreshAuthentication({ onlyIfChanged = false } = {}) {
    const before = this._getAuthCode();
    await this._fetchAndStoreAuthCode();

    const authCode = this._getAuthCode();
    if (!authCode || authCode === '00000000') return false;
    if (onlyIfChanged && authCode === before) return false;

    // A stored code is not enough: this session must also be authenticated
    // with it, otherwise the fan keeps ignoring every command
    try {
      await this._writeAuthCode(authCode);
      // Unknown until the fan reports again - the 'false' from before this
      // write must not keep blocking commands
      this._lastAuthenticated = null;
      return true;
    } catch (err) {
      this.error(`Picked up an auth code but could not authenticate: ${err.message}`);
      return false;
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
    await this._gattWrite(char, authBuffer, 'Auth');
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
        const data = await this._gattRead(char, 'Auth');
        const authCode = Parser.parseAuthCode(data);

        if (!authCode) return;

        // The fan returns 00000000 when it is NOT in pairing mode
        // (pyfreshintellivent: "Fan was not in pairing mode"). Never let that
        // overwrite a previously stored real code - a transient auth failure
        // would otherwise permanently lock the device into read-only mode.
        const existingCode = this._getAuthCode();
        if (authCode === '00000000' && existingCode && existingCode !== '00000000') {
          this.log('Fan not in pairing mode; keeping stored auth code');
          return;
        }

        // Nothing changed - skip the settings write. The read-only retry path
        // lands here every minute, and re-writing the same 00000000 marker
        // would churn settings (and the timeline) for no reason.
        if (authCode === existingCode) return;

        await this._setAuthCode(authCode);
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
   * @param {object} [options]
   * @param {number} [options.retries] - Extra attempts after the first.
   *   Defaults to MAX_RECONNECT_ATTEMPTS for user-initiated commands; the
   *   background poll passes 0 and leaves retrying to the reconnect scheduler.
   * @param {number} [options.timeout] - Total time the caller waits, queueing
   *   and reconnecting included (USER_COMMAND_TIMEOUT by default, 0 for
   *   none). Past it the caller gets an error, and an operation that has not
   *   started yet is dropped instead of running late.
   * @returns {*} - Result of the operation
   */
  async _withConnection(operation, {
    retries = Constants.MAX_RECONNECT_ATTEMPTS,
    timeout = Constants.USER_COMMAND_TIMEOUT,
  } = {}) {
    const deadline = timeout > 0 ? Date.now() + timeout : null;

    // Queue operations to prevent concurrent BLE access. The stored queue tail
    // must never be a rejected promise: chaining .then() on a rejection would
    // skip every subsequent operation and replay the stale error forever.
    // Errors are delivered to the caller via `run`; the tail swallows them.
    const run = this._operationQueue
      .catch(() => {}) // previous operation's error was already delivered to its caller
      .then(() => this._executeWithRetry(operation, retries, deadline));
    this._operationQueue = run.catch(() => {});
    if (!deadline) return run;

    try {
      return await this._withTimeout(run, timeout, 'Command');
    } catch (err) {
      if (err.timedOut) err.commandTimeout = true;
      throw err;
    }
  }

  /**
   * The error for a command whose caller has given up
   * @returns {Error}
   */
  static _commandExpired() {
    const err = new Error('Command expired before it could run');
    err.commandTimeout = true;
    return err;
  }

  /**
   * Run one BLE operation, reconnecting on connection errors.
   * @param {Function} operation - The operation to execute
   * @param {number} retries - Extra attempts after the first
   * @param {number|null} [deadline] - Timestamp after which the caller has
   *   given up; the operation is then not started
   * @returns {*} - Result of the operation
   */
  async _executeWithRetry(operation, retries = Constants.MAX_RECONNECT_ATTEMPTS, deadline = null) {
    let lastError = null;
    const expired = () => deadline !== null && Date.now() >= deadline;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this._isDeleted) {
        throw new Error('Device has been deleted');
      }
      if (expired()) throw IntelliventSkyDevice._commandExpired();
      try {
        await this._connect();
        // The connect may have taken long enough that the caller gave up.
        // Keep the connection (the poll uses it), but don't run the command.
        if (expired()) throw IntelliventSkyDevice._commandExpired();
        const result = await operation();
        return result;
      } catch (err) {
        lastError = err;
        this.log(`Operation failed (attempt ${attempt + 1}): ${err.message}`);

        // Rate limiting is a deliberate back-off, not a transient fault.
        // Retrying burns the whole attempt budget inside the cooldown window
        // and turns one failure into four identical log lines.
        if (err.rateLimited || err.commandTimeout) {
          throw err;
        }

        // If connection issue, try to reconnect
        if (this._isConnectionError(err)) {
          await this._teardownConnection();

          const delay = Math.min(
            Constants.RECONNECT_DELAY * (2 ** attempt),
            Constants.MAX_RECONNECT_DELAY,
          );
          // No point waiting past the caller's deadline
          if (deadline !== null && Date.now() + delay >= deadline) break;

          if (attempt < retries) {
            // Exponential backoff. A fixed short delay turns a fan that is
            // briefly unreachable into a scan storm, and the scan churn from
            // several devices retrying in lockstep is itself enough to
            // destabilise Homey's BLE stack.
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

      // Single attempt: the reconnect scheduler owns retrying, with a backoff
      // that survives across calls. Retrying here as well would multiply the
      // scan churn and keep the rate limiter permanently armed.
      await this._withConnection(async () => {
        const char = this._characteristics.deviceStatus;
        if (!char) {
          // _connect() refuses a connection without it, so this is a link
          // that lost its GATT cache - rebuild it
          const err = new Error('Device status characteristic not found');
          err.connectionLost = true;
          throw err;
        }

        let data;
        try {
          data = await this._gattRead(char, 'Status');
        } catch (err) {
          // This read is the connection heartbeat. When it fails, the link is
          // presumed dead whatever the error says: a link that dropped
          // without a disconnect event (sdk-issues#315) still looks
          // connected, and without a teardown every later poll would fail
          // against the same dead peripheral - with no reconnect scheduled,
          // because the device still counts as connected.
          err.connectionLost = true;
          throw err;
        }
        const sensorData = Parser.parseSensorData(data);

        // Logged on change only - every 20 s is a lot of identical lines
        const summary = JSON.stringify(sensorData);
        if (summary !== this._lastSensorLog) {
          this._lastSensorLog = summary;
          this.log(`Sensor data: ${summary}`);
        }

        // Update capabilities
        await this._queueCapabilityUpdate(sensorData);

        // Cheap piggyback on the poll: pick up an auth code if the fan has
        // since been put into pairing mode
        await this._retryAuthIfNeeded();

        this._noteStableConnection();
      }, { retries: 0, timeout: 0 });
    } catch (err) {
      this.error(`Failed to fetch sensor data: ${err.message}`);

      // Distinguish "this fan is unreachable" from "Homey's BLE scanner has
      // stopped working", which look identical from here but need completely
      // different things from the user
      const wedged = typeof this.homey.app.bleStackLooksWedged === 'function'
        && this.homey.app.bleStackLooksWedged();
      const reason = wedged ? 'errors.ble_unavailable' : 'errors.connection_failed';
      if (reason !== this._unavailableKey || this.getAvailable()) {
        this._unavailableKey = reason;
        this.setUnavailable(this.homey.__(reason)).catch(this.error);
      }

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
      await this.setCapabilityValue('measure_humidity', sensorData.humidity).catch(this.error);

      // Trigger humidity changed flow, on a meaningful change only
      const baseline = this._humidityTriggerBaseline;
      if (typeof baseline !== 'number') {
        this._humidityTriggerBaseline = sensorData.humidity;
      } else if (Math.abs(sensorData.humidity - baseline) >= Constants.HUMIDITY_TRIGGER_DELTA) {
        this._humidityTriggerBaseline = sensorData.humidity;
        await this.homey.flow.getDeviceTriggerCard('humidity_changed')
          .trigger(this, { humidity: sensorData.humidity })
          .catch(this.error);
      }
    }

    // Check for mode change and trigger flow (compare against the value
    // captured before the capability was updated)
    if (sensorData.mode !== null && previousMode !== sensorData.mode) {
      await this._triggerModeChanged(sensorData.mode);
    }

    // Device is available
    if (!this.getAvailable()) {
      await this.setAvailable().catch(this.error);
    }
    this._unavailableKey = undefined;

    this._lastAuthenticated = sensorData.authenticated;

    // Surface unauthenticated state: the fan silently ignores writes when not
    // authenticated, which would otherwise look like working control. The
    // read-only case (auth code 00000000) is the one that most needs a banner.
    // Applied on change only.
    let warningKey = null;
    if (!sensorData.authenticated) {
      warningKey = this._isReadOnly() ? 'errors.read_only' : 'errors.not_authenticated';
    }
    if (warningKey !== this._warningKey) {
      this._warningKey = warningKey;
      if (warningKey) {
        await this.setWarning(this.homey.__(warningKey)).catch(this.error);
      } else {
        await this.unsetWarning().catch(this.error);
      }
    }
  }

  /**
   * Fire mode_changed. `mode` stays the stable id Flows can compare against;
   * `mode_name` is the translated name for notifications and speech.
   * @param {string} mode - Mode id
   */
  async _triggerModeChanged(mode) {
    const key = `modes.${mode}`;
    const name = this.homey.__(key);
    await this.homey.flow.getDeviceTriggerCard('mode_changed')
      .trigger(this, { mode, mode_name: name && name !== key ? name : mode })
      .catch(this.error);
  }

  /**
   * Turn the fan off or on.
   *
   * Off pauses the fan. On undoes that without touching the fan's
   * configuration: ending a pause lets the fan resume whatever it is set up
   * to do (humidity, light, VOC, constant speed). Only when nothing is set up
   * to run at all (mode 'off') does On fall back to constant speed. Turning
   * on used to always enable constant speed, which permanently replaced an
   * automatic setup with a fan that never stops.
   * @param {boolean} on - True to turn on
   */
  async setOnOff(on) {
    this._checkWriteAccess();
    const mode = this.getCapabilityValue('intellivent_mode');

    let shown = null;
    await this._withConnection(async () => {
      if (!on) {
        await this._setPause(true, 0);
        shown = 'pause';
      } else if (mode === 'off') {
        await this._setConstantSpeed(true, this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM);
        shown = 'constant_speed';
      } else if (mode === 'pause' || mode === null) {
        // What the fan resumes is up to its configuration: its next status
        // report shows it (null = no report yet, so end any pause to be sure)
        await this._setPause(false, 0);
      }
      // Any other mode: already running, nothing to write
    });

    if (shown) await this._setModeCapability(shown);
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
      // after this optimistic update). Only for modes the fan then actually
      // reports: humidity/light/VOC/airing writes enable a feature, and the
      // fan decides when it runs - showing them straight away made the mode
      // flip back on the next report and fire mode_changed twice.
      // 'off' is written as a pause, and the fan reports it as one - show
      // that, rather than 'off' flipping to 'pause' on the next report
      const shown = mode === 'off' ? 'pause' : mode;
      if (IntelliventSkyDevice.OPTIMISTIC_MODES.includes(shown)) {
        await this._setModeCapability(shown);
        await this.setCapabilityValue('onoff', shown !== 'pause').catch(this.error);
      }
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
    await this.setCapabilityValue('intellivent_mode', mode).catch(this.error);
    if (previous !== mode) {
      await this._triggerModeChanged(mode);
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
    await this.setCapabilityValue('intellivent_rpm', rpm).catch(this.error);
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

    // Update capabilities. A failure here must not report the (successful)
    // write as failed. The mode is left to the fan's next report - enabling
    // humidity detection does not by itself put the fan in humidity mode.
    await this.setCapabilityValue('intellivent_humidity_enabled', enabled).catch(this.error);
    await this.setCapabilityValue('intellivent_humidity_sensitivity', String(sensitivity)).catch(this.error);

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

    await this.setCapabilityValue('intellivent_humidity_enabled', enabled).catch(this.error);

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

    await this.setCapabilityValue('intellivent_humidity_sensitivity', String(sensitivity)).catch(this.error);

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

    await this.setCapabilityValue('intellivent_light_enabled', enabled).catch(this.error);

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

    await this.setCapabilityValue('intellivent_light_sensitivity', String(sensitivity)).catch(this.error);

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

    await this.setCapabilityValue('intellivent_voc_enabled', enabled).catch(this.error);

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

    await this.setCapabilityValue('intellivent_voc_sensitivity', String(sensitivity)).catch(this.error);

    this.log(`VOC sensitivity set to ${sensitivity}`);
  }

  // BLE write operations

  async _setConstantSpeed(enabled, rpm) {
    const char = this._characteristics.constantSpeed;
    if (!char) throw new Error('Constant speed characteristic not found');
    const data = Parser.encodeConstantSpeed(enabled, rpm);
    await this._gattWrite(char, data, 'Constant speed');
  }

  async _setHumidity(enabled, detection, rpm) {
    const char = this._characteristics.humidity;
    if (!char) throw new Error('Humidity characteristic not found');
    const data = Parser.encodeHumidity(enabled, detection, rpm);
    await this._gattWrite(char, data, 'Humidity');
    // The write succeeded - the device now holds this value
    this._deviceConfig.humidityRpm = Parser.validateRpm(rpm);
  }

  async _setLightVoc(lightEnabled, lightDetection, vocEnabled, vocDetection) {
    const char = this._characteristics.lightVoc;
    if (!char) throw new Error('Light/VOC characteristic not found');
    const data = Parser.encodeLightVoc(lightEnabled, lightDetection, vocEnabled, vocDetection);
    await this._gattWrite(char, data, 'Light/VOC');
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
    await this._gattWrite(char, data, 'Timer');
  }

  async _setAiring(enabled, minutes, rpm) {
    const char = this._characteristics.airing;
    if (!char) throw new Error('Airing characteristic not found');
    const data = Parser.encodeAiring(enabled, minutes, rpm);
    await this._gattWrite(char, data, 'Airing');
  }

  async _setPause(enabled, duration) {
    const char = this._characteristics.pause;
    if (!char) throw new Error('Pause characteristic not found');
    const data = Parser.encodePause(enabled, duration);
    await this._gattWrite(char, data, 'Pause');
  }

  async _setBoost(enabled, rpm, duration) {
    const char = this._characteristics.boost;
    if (!char) throw new Error('Boost characteristic not found');
    const data = Parser.encodeBoost(enabled, rpm, duration);
    await this._gattWrite(char, data, 'Boost');
  }

  async _setTemporarySpeed(rpm) {
    await this._withConnection(async () => {
      const char = this._characteristics.temporarySpeed;
      if (!char) throw new Error('Temporary speed characteristic not found');
      const data = Parser.encodeTemporarySpeed(rpm);
      await this._gattWrite(char, data, 'Temporary speed');
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

    await this._disconnect().catch((err) => this.error(`Teardown failed: ${err.message}`));
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
    await this._disconnect();
  }

}

// Modes shown as soon as Homey writes them, because the fan reports exactly
// these back. Everything else waits for the fan's own status report.
IntelliventSkyDevice.OPTIMISTIC_MODES = ['pause', 'constant_speed', 'boost', 'timer'];

module.exports = IntelliventSkyDevice;
