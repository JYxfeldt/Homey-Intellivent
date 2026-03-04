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
    this._connectionIdleTimer = null;
    this._reconnectAttempts = 0;
    this._operationQueue = Promise.resolve();

    // Rate limiting state
    this._connectionFailures = []; // Timestamps of recent failures
    this._extendedCooldownUntil = 0; // Timestamp when extended cooldown ends
    this._lastAuthRegenTime = 0; // Timestamp of last auth code regeneration

    // Ensure new capabilities exist on already-paired devices
    await this._migrateCapabilities();

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
    const newCapabilities = ['measure_temperature.average', 'measure_rpm'];
    for (const cap of newCapabilities) {
      if (!this.hasCapability(cap)) {
        this.log(`Adding missing capability: ${cap}`);
        await this.addCapability(cap);
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
      if (value) {
        // Turn on - set to constant speed mode with default RPM
        await this._setConstantSpeed(true, Constants.DEFAULT_RPM);
      } else {
        // Turn off - disable all modes by pausing
        await this._setPause(true, 0);
      }
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
  }

  /**
   * Start polling for sensor data
   */
  _startPolling() {
    // Clear any existing interval
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
    }

    // Poll every minute
    this._pollInterval = this.homey.setInterval(() => {
      this._fetchSensorData();
    }, Constants.POLL_INTERVAL);
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
      throw new Error(`Connection rate limited. Try again in ${remainingSeconds} seconds.`);
    }

    // Clean up old failures outside the window
    this._connectionFailures = this._connectionFailures.filter(
      (timestamp) => now - timestamp < Constants.CONNECTION_FAILURE_WINDOW
    );

    // Check if too many recent failures
    if (this._connectionFailures.length >= Constants.MAX_CONNECTION_FAILURES) {
      this._extendedCooldownUntil = now + Constants.EXTENDED_COOLDOWN;
      this._connectionFailures = []; // Reset after triggering cooldown
      const cooldownSeconds = Constants.EXTENDED_COOLDOWN / 1000;
      this.log(`Too many connection failures. Entering ${cooldownSeconds}s cooldown.`);
      throw new Error(`Too many connection failures. Try again in ${cooldownSeconds} seconds.`);
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

    // Reset idle timer on every connection attempt
    this._resetIdleTimer();

    // Already connected
    if (this._isConnected && this._peripheral) {
      return this._peripheral;
    }

    // Wait if connection is in progress
    if (this._isConnecting) {
      // Wait for connection to complete
      while (this._isConnecting) {
        await new Promise(resolve => this.homey.setTimeout(resolve, 100));
      }
      if (this._isConnected && this._peripheral) {
        return this._peripheral;
      }
    }

    this._isConnecting = true;

    try {
      const uuid = this.getData().uuid;
      this.log(`Connecting to device ${uuid}...`);

      // Find the device
      const advertisement = await this.homey.ble.find(uuid, Constants.CONNECTION_TIMEOUT);

      if (!advertisement) {
        throw new Error('Device not found');
      }

      // Connect to the device
      this._peripheral = await advertisement.connect();
      this.log('Connected to device');

      // Set up disconnect handler
      this._peripheral.once('disconnect', () => {
        this.log('Device disconnected unexpectedly');
        this._isConnected = false;
        this._peripheral = null;
        this._characteristics = {};
      });

      // Discover services and characteristics
      await this._peripheral.discoverAllServicesAndCharacteristics();

      // Cache characteristics
      await this._cacheCharacteristics();

      // Authenticate if we have an auth code
      await this._authenticate();

      this._isConnected = true;
      this._reconnectAttempts = 0;

      return this._peripheral;
    } catch (err) {
      this._isConnected = false;
      this._peripheral = null;
      this._characteristics = {};
      this._recordConnectionFailure();
      throw err;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Reset the connection idle timer
   */
  _resetIdleTimer() {
    // Clear existing timer
    if (this._connectionIdleTimer) {
      this.homey.clearTimeout(this._connectionIdleTimer);
    }

    // Set new idle timer
    this._connectionIdleTimer = this.homey.setTimeout(() => {
      this.log('Connection idle timeout reached, disconnecting...');
      this._disconnect();
    }, Constants.CONNECTION_IDLE_TIMEOUT);
  }

  /**
   * Disconnect from the BLE device
   * @param {boolean} force - Force disconnect even if operations pending
   */
  async _disconnect(force = false) {
    // Clear idle timer
    if (this._connectionIdleTimer) {
      this.homey.clearTimeout(this._connectionIdleTimer);
      this._connectionIdleTimer = null;
    }

    if (this._peripheral) {
      try {
        await this._peripheral.disconnect();
        this.log('Disconnected from device');
      } catch (err) {
        this.log(`Error disconnecting: ${err.message}`);
      }
      this._peripheral = null;
      this._characteristics = {};
      this._isConnected = false;
    }
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

    for (const service of this._peripheral.services) {
      for (const characteristic of service.characteristics) {
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
   * Authenticate with the device
   */
  async _authenticate() {
    const authCode = this.getSetting('auth_code');

    if (!authCode) {
      this.log('No auth code stored, attempting to fetch...');
      await this._fetchAndStoreAuthCode();
      return;
    }

    try {
      const char = this._characteristics.auth;
      if (char) {
        const authBuffer = Parser.encodeAuthCode(authCode);
        await char.write(authBuffer);
        this.log('Authentication successful');
      }
    } catch (err) {
      this.error(`Authentication failed: ${err.message}`);
      // Try to fetch a new auth code
      await this._fetchAndStoreAuthCode();
    }
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
        (Constants.AUTH_REGEN_COOLDOWN - (Date.now() - this._lastAuthRegenTime)) / 1000
      );
      this.log(`Auth code regeneration on cooldown. ${remainingSeconds}s remaining.`);
      return;
    }

    try {
      const char = this._characteristics.auth;
      if (char) {
        const data = await char.read();
        const authCode = Parser.parseAuthCode(data);

        if (authCode) {
          await this.setSettings({ auth_code: authCode });
          this._lastAuthRegenTime = Date.now();
          this.log('Stored new auth code');
        }
      }
    } catch (err) {
      this.error(`Failed to fetch auth code: ${err.message}`);
    }
  }

  /**
   * Execute a BLE operation with automatic connection handling
   * Maintains persistent connection with idle timeout
   * @param {Function} operation - The operation to execute
   * @returns {*} - Result of the operation
   */
  async _withConnection(operation) {
    // Queue operations to prevent concurrent BLE access
    this._operationQueue = this._operationQueue.then(async () => {
      let lastError = null;

      for (let attempt = 0; attempt <= Constants.MAX_RECONNECT_ATTEMPTS; attempt++) {
        try {
          await this._connect();
          const result = await operation();
          // Reset idle timer after successful operation
          this._resetIdleTimer();
          return result;
        } catch (err) {
          lastError = err;
          this.log(`Operation failed (attempt ${attempt + 1}): ${err.message}`);

          // If connection issue, try to reconnect
          if (!this._isConnected || err.message.includes('not connected') || err.message.includes('disconnected')) {
            this._isConnected = false;
            this._peripheral = null;
            this._characteristics = {};

            if (attempt < Constants.MAX_RECONNECT_ATTEMPTS) {
              this.log(`Reconnecting in ${Constants.RECONNECT_DELAY / 1000} seconds...`);
              await new Promise(resolve => this.homey.setTimeout(resolve, Constants.RECONNECT_DELAY));
            }
          } else {
            // Non-connection error, don't retry
            throw err;
          }
        }
      }

      throw lastError;
    }).catch(err => {
      // Propagate error but keep the queue working for future operations
      throw err;
    });

    return this._operationQueue;
  }

  /**
   * Fetch sensor data from device
   */
  async _fetchSensorData() {
    try {
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
        await this._updateCapabilities(sensorData);
      });
    } catch (err) {
      this.error(`Failed to fetch sensor data: ${err.message}`);
      this.setUnavailable(this.homey.__('errors.connection_failed')).catch(this.error);
    }
  }

  /**
   * Update capabilities based on sensor data
   * @param {object} sensorData - Parsed sensor data
   */
  async _updateCapabilities(sensorData) {
    // Update on/off state
    const isOn = sensorData.mode !== 'off' && sensorData.mode !== 'pause';
    await this.setCapabilityValue('onoff', isOn).catch(this.error);

    // Update mode
    await this.setCapabilityValue('intellivent_mode', sensorData.mode).catch(this.error);

    // Update live RPM sensor (read-only, actual measured value)
    await this.setCapabilityValue('measure_rpm', sensorData.rpm).catch(this.error);

    // Update temperature
    if (sensorData.temperature > 0) {
      await this.setCapabilityValue('measure_temperature', sensorData.temperature).catch(this.error);
    }

    // Update average temperature
    if (sensorData.avgTemperature > 0) {
      await this.setCapabilityValue('measure_temperature.average', sensorData.avgTemperature).catch(this.error);
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

    // Check for mode change and trigger flow
    const currentMode = this.getCapabilityValue('intellivent_mode');
    if (currentMode !== sensorData.mode) {
      await this.homey.flow.getDeviceTriggerCard('mode_changed')
        .trigger(this, { mode: sensorData.mode })
        .catch(this.error);
    }

    // Device is available
    await this.setAvailable().catch(this.error);
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
            // Use configured humidity settings
            const sensitivity = parseInt(this.getSetting('humidity_sensitivity') || '1', 10);
            const humidityRpm = this.getSetting('humidity_rpm') || this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM;
            await this._setHumidity(true, sensitivity, humidityRpm);
            break;
          }
          case 'light':
            await this._setLightVoc(true, 'medium', false, 'medium');
            break;
          case 'voc':
            await this._setLightVoc(false, 'medium', true, 'medium');
            break;
          case 'boost':
            await this._setBoost(true, Constants.MAX_RPM, 15);
            break;
          case 'airing':
            await this._setAiring(true, 10, 50, this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM);
            break;
          case 'timer':
            await this._setTimer(30, false, 0, this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM);
            break;
          default:
            throw new Error(`Unknown mode: ${mode}`);
        }
      });

      // Update capability
      await this.setCapabilityValue('intellivent_mode', mode);
    } catch (err) {
      this.error(`Failed to set mode: ${err.message}`);
      throw err;
    }
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
    await this.setCapabilityValue('intellivent_mode', 'boost');
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

    // Update settings to reflect the new configuration
    await this.setSettings({
      humidity_enabled: enabled,
      humidity_sensitivity: String(sensitivity),
      humidity_rpm: rpm,
    });

    // If enabled, update mode
    if (enabled) {
      await this.setCapabilityValue('intellivent_mode', 'humidity');
    }

    this.log(`Humidity detection configured: enabled=${enabled}, sensitivity=${sensitivity}, rpm=${rpm}`);
  }

  /**
   * Set humidity detection enabled/disabled
   * @param {boolean} enabled - Enable or disable humidity detection
   */
  async setHumidityEnabled(enabled) {
    this._checkWriteAccess();
    const sensitivity = parseInt(this.getCapabilityValue('intellivent_humidity_sensitivity') || '1', 10);
    const rpm = this.getSetting('humidity_rpm') || this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM;

    await this._withConnection(async () => {
      await this._setHumidity(enabled, sensitivity, rpm);
    });

    await this.setCapabilityValue('intellivent_humidity_enabled', enabled);
    await this.setSettings({ humidity_enabled: enabled });

    this.log(`Humidity detection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set humidity sensitivity
   * @param {number} sensitivity - Sensitivity level (0=low, 1=medium, 2=high)
   */
  async setHumiditySensitivity(sensitivity) {
    this._checkWriteAccess();
    const rpm = this.getSetting('humidity_rpm') || this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM;
    const enabled = this.getCapabilityValue('intellivent_humidity_enabled') !== false;

    await this._withConnection(async () => {
      await this._setHumidity(enabled, sensitivity, rpm);
    });

    // Update settings
    await this.setSettings({ humidity_sensitivity: String(sensitivity) });
    await this.setCapabilityValue('intellivent_humidity_sensitivity', String(sensitivity));

    this.log(`Humidity sensitivity set to ${sensitivity}`);
  }

  /**
   * Set light detection enabled/disabled
   * @param {boolean} enabled - Enable or disable light detection
   */
  async setLightEnabled(enabled) {
    this._checkWriteAccess();
    const lightSensitivity = parseInt(this.getCapabilityValue('intellivent_light_sensitivity') || '1', 10);
    const vocEnabled = this.getCapabilityValue('intellivent_voc_enabled') === true;
    const vocSensitivity = parseInt(this.getCapabilityValue('intellivent_voc_sensitivity') || '1', 10);

    await this._withConnection(async () => {
      await this._setLightVoc(enabled, lightSensitivity, vocEnabled, vocSensitivity);
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
    const lightEnabled = this.getCapabilityValue('intellivent_light_enabled') === true;
    const vocEnabled = this.getCapabilityValue('intellivent_voc_enabled') === true;
    const vocSensitivity = parseInt(this.getCapabilityValue('intellivent_voc_sensitivity') || '1', 10);

    await this._withConnection(async () => {
      await this._setLightVoc(lightEnabled, sensitivity, vocEnabled, vocSensitivity);
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
    const lightEnabled = this.getCapabilityValue('intellivent_light_enabled') === true;
    const lightSensitivity = parseInt(this.getCapabilityValue('intellivent_light_sensitivity') || '1', 10);
    const vocSensitivity = parseInt(this.getCapabilityValue('intellivent_voc_sensitivity') || '1', 10);

    await this._withConnection(async () => {
      await this._setLightVoc(lightEnabled, lightSensitivity, enabled, vocSensitivity);
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
    const lightEnabled = this.getCapabilityValue('intellivent_light_enabled') === true;
    const lightSensitivity = parseInt(this.getCapabilityValue('intellivent_light_sensitivity') || '1', 10);
    const vocEnabled = this.getCapabilityValue('intellivent_voc_enabled') === true;

    await this._withConnection(async () => {
      await this._setLightVoc(lightEnabled, lightSensitivity, vocEnabled, sensitivity);
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
  }

  async _setLightVoc(lightEnabled, lightDetection, vocEnabled, vocDetection) {
    const char = this._characteristics.lightVoc;
    if (!char) throw new Error('Light/VOC characteristic not found');
    const data = Parser.encodeLightVoc(lightEnabled, lightDetection, vocEnabled, vocDetection);
    await char.write(data);
  }

  async _setTimer(duration, delayEnabled, delayMinutes, rpm) {
    const char = this._characteristics.timer;
    if (!char) throw new Error('Timer characteristic not found');
    const data = Parser.encodeTimer(duration, delayEnabled, delayMinutes, rpm);
    await char.write(data);
  }

  async _setAiring(enabled, onTime, offTime, rpm) {
    const char = this._characteristics.airing;
    if (!char) throw new Error('Airing characteristic not found');
    const data = Parser.encodeAiring(enabled, onTime, offTime, rpm);
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

    // Check if humidity settings changed
    const humidityKeys = ['humidity_enabled', 'humidity_sensitivity', 'humidity_rpm'];
    const humidityChanged = changedKeys.some(key => humidityKeys.includes(key));

    if (humidityChanged) {
      // Check for read-only mode (use newSettings in case auth_code changed)
      const authCode = newSettings.auth_code || this.getSetting('auth_code');
      if (authCode === '00000000') {
        throw new Error(this.homey.__('errors.read_only'));
      }

      const enabled = newSettings.humidity_enabled;
      const sensitivity = parseInt(newSettings.humidity_sensitivity, 10);
      const rpm = newSettings.humidity_rpm;

      this.log(`Updating humidity settings: enabled=${enabled}, sensitivity=${sensitivity}, rpm=${rpm}`);

      try {
        await this._withConnection(async () => {
          await this._setHumidity(enabled, sensitivity, rpm);
        });

        // Update mode capability if humidity is enabled
        if (enabled) {
          await this.setCapabilityValue('intellivent_mode', 'humidity');
        }
      } catch (err) {
        this.error(`Failed to update humidity settings: ${err.message}`);
        throw new Error(this.homey.__('errors.write_failed'));
      }
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name) {
    this.log(`Intellivent Sky device was renamed to ${name}`);
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    this.log('Intellivent Sky device has been deleted');

    // Stop polling
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }

    // Clear idle timer
    if (this._connectionIdleTimer) {
      this.homey.clearTimeout(this._connectionIdleTimer);
      this._connectionIdleTimer = null;
    }

    // Disconnect
    await this._disconnect(true);
  }

}

module.exports = IntelliventSkyDevice;
