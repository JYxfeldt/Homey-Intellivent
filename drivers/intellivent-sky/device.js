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

    // Register capability listeners
    this._registerCapabilityListeners();

    // Start polling for sensor data
    this._startPolling();

    // Initial data fetch
    this._fetchSensorData();
  }

  /**
   * Register capability listeners
   */
  _registerCapabilityListeners() {
    // On/Off capability
    this.registerCapabilityListener('onoff', async (value) => {
      this.log(`Setting onoff to ${value}`);
      if (value) {
        // Turn on - set to constant speed mode with default RPM
        await this._setConstantSpeed(true, Constants.DEFAULT_RPM);
      } else {
        // Turn off - disable all modes by pausing
        await this._setPause(true, 0);
      }
    });

    // Fan speed capability (0-100%)
    this.registerCapabilityListener('fan_speed', async (value) => {
      this.log(`Setting fan_speed to ${value}%`);
      // Convert percentage to RPM (800-2400)
      const rpm = Math.round(Constants.MIN_RPM + (value / 100) * (Constants.MAX_RPM - Constants.MIN_RPM));
      await this._setTemporarySpeed(rpm);
    });

    // Mode capability
    this.registerCapabilityListener('intellivent_mode', async (value) => {
      this.log(`Setting mode to ${value}`);
      await this.setMode(value);
    });

    // RPM capability
    this.registerCapabilityListener('intellivent_rpm', async (value) => {
      this.log(`Setting RPM to ${value}`);
      await this.setRpm(value);
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
   * Connect to the BLE device
   * @returns {BlePeripheral} - The connected peripheral
   */
  async _connect() {
    if (this._isConnecting) {
      throw new Error('Connection already in progress');
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

      // Discover services and characteristics
      await this._peripheral.discoverAllServicesAndCharacteristics();

      // Cache characteristics
      await this._cacheCharacteristics();

      // Authenticate if we have an auth code
      await this._authenticate();

      return this._peripheral;
    } finally {
      this._isConnecting = false;
    }
  }

  /**
   * Disconnect from the BLE device
   */
  async _disconnect() {
    if (this._peripheral) {
      try {
        await this._peripheral.disconnect();
        this.log('Disconnected from device');
      } catch (err) {
        this.log(`Error disconnecting: ${err.message}`);
      }
      this._peripheral = null;
      this._characteristics = {};
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
   * Fetch and store authentication code from device
   */
  async _fetchAndStoreAuthCode() {
    try {
      const char = this._characteristics.auth;
      if (char) {
        const data = await char.read();
        const authCode = Parser.parseAuthCode(data);

        if (authCode) {
          await this.setSettings({ auth_code: authCode });
          this.log(`Stored new auth code: ${authCode}`);
        }
      }
    } catch (err) {
      this.error(`Failed to fetch auth code: ${err.message}`);
    }
  }

  /**
   * Execute a BLE operation with automatic connection handling
   * @param {Function} operation - The operation to execute
   * @returns {*} - Result of the operation
   */
  async _withConnection(operation) {
    try {
      await this._connect();
      return await operation();
    } finally {
      await this._disconnect();
    }
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

    // Update RPM
    await this.setCapabilityValue('intellivent_rpm', sensorData.rpm).catch(this.error);

    // Update fan speed percentage
    const speedPercent = Math.round(((sensorData.rpm - Constants.MIN_RPM) / (Constants.MAX_RPM - Constants.MIN_RPM)) * 100);
    await this.setCapabilityValue('fan_speed', Math.max(0, Math.min(100, speedPercent))).catch(this.error);

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
          case 'humidity':
            await this._setHumidity(true, 'medium', this.getCapabilityValue('intellivent_rpm') || Constants.DEFAULT_RPM);
            break;
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
    await this._setTemporarySpeed(rpm);
    await this.setCapabilityValue('intellivent_rpm', rpm);

    // Update fan speed percentage
    const speedPercent = Math.round(((rpm - Constants.MIN_RPM) / (Constants.MAX_RPM - Constants.MIN_RPM)) * 100);
    await this.setCapabilityValue('fan_speed', Math.max(0, Math.min(100, speedPercent)));
  }

  /**
   * Start boost mode
   * @param {number} duration - Duration in minutes
   * @param {number} rpm - RPM value
   */
  async startBoost(duration, rpm) {
    await this._withConnection(async () => {
      await this._setBoost(true, rpm, duration);
    });
    await this.setCapabilityValue('intellivent_mode', 'boost');
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
    }

    // Disconnect
    await this._disconnect();
  }

}

module.exports = IntelliventSkyDevice;
