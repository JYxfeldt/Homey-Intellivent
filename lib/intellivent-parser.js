'use strict';

const Constants = require('./intellivent-constants');

/**
 * Parser for Intellivent Sky BLE data
 * Ported from: https://github.com/JYxfeldt/pyfreshintellivent
 */
class IntelliventParser {

  /**
   * Validate and constrain RPM value
   * @param {number} rpm - The RPM value to validate
   * @returns {number} - Validated RPM value
   */
  static validateRpm(rpm) {
    return Math.max(Constants.MIN_RPM, Math.min(Constants.MAX_RPM, Math.round(rpm)));
  }

  /**
   * Validate detection level (0-3)
   * @param {number|string} level - Detection level
   * @returns {number} - Validated level (0-3)
   */
  static validateDetection(level) {
    if (typeof level === 'string') {
      const levelMap = { low: 0, medium: 1, high: 2, custom: 3 };
      return levelMap[level.toLowerCase()] ?? 1;
    }
    return Math.max(0, Math.min(3, Math.round(level)));
  }

  /**
   * Validate time value (non-negative)
   * @param {number} time - Time value
   * @returns {number} - Validated time value
   */
  static validateTime(time) {
    return Math.max(0, Math.round(time));
  }

  /**
   * Parse sensor data from device (15 bytes)
   * Format: <2B2H2B2H3B
   * @param {Buffer} data - Raw sensor data
   * @returns {object} - Parsed sensor data
   */
  static parseSensorData(data) {
    if (data.length !== 15) {
      throw new Error(`Sensor data must be 15 bytes, got ${data.length}`);
    }

    const status = data.readUInt8(0);
    const modeRaw = data.readUInt8(1);
    const humidityRaw = data.readUInt16LE(2);
    const temperatureRaw = data.readUInt16LE(4);
    const avgTemperatureRaw = data.readUInt8(6);
    const _reserved = data.readUInt8(7);
    const rpm = data.readUInt16LE(8);
    const _reserved2 = data.readUInt16LE(10);
    const _reserved3 = data.readUInt8(12);
    const _reserved4 = data.readUInt8(13);
    const authenticated = data.readUInt8(14);

    // Calculate humidity using logarithmic formula
    let humidity = 0;
    if (humidityRaw > 0) {
      humidity = Math.round(Math.log(humidityRaw / 10) * 10);
    }

    // Temperature is in centidegrees
    const temperature = temperatureRaw / 100;
    const avgTemperature = avgTemperatureRaw;

    return {
      status: Boolean(status),
      mode: Constants.MODE_MAP[modeRaw] || 'off',
      modeRaw,
      humidity,
      temperature,
      avgTemperature,
      rpm,
      authenticated: Boolean(authenticated),
    };
  }

  /**
   * Parse constant speed data (3 bytes)
   * Format: <?H (enabled: bool, rpm: uint16)
   * @param {Buffer} data - Raw data
   * @returns {object} - Parsed data
   */
  static parseConstantSpeed(data) {
    if (data.length < 3) {
      throw new Error(`Constant speed data must be at least 3 bytes, got ${data.length}`);
    }
    return {
      enabled: Boolean(data.readUInt8(0)),
      rpm: data.readUInt16LE(1),
    };
  }

  /**
   * Encode constant speed settings
   * @param {boolean} enabled - Enable constant speed mode
   * @param {number} rpm - Fan speed in RPM
   * @returns {Buffer} - Encoded data
   */
  static encodeConstantSpeed(enabled, rpm) {
    const buffer = Buffer.alloc(3);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt16LE(this.validateRpm(rpm), 1);
    return buffer;
  }

  /**
   * Parse humidity mode data (4 bytes)
   * Format: <?BH (enabled: bool, detection: uint8, rpm: uint16)
   * @param {Buffer} data - Raw data
   * @returns {object} - Parsed data
   */
  static parseHumidity(data) {
    if (data.length < 4) {
      throw new Error(`Humidity data must be at least 4 bytes, got ${data.length}`);
    }
    const detection = data.readUInt8(1);
    return {
      enabled: Boolean(data.readUInt8(0)),
      detection: Constants.DETECTION_LEVELS[detection] || 'medium',
      detectionRaw: detection,
      rpm: data.readUInt16LE(2),
    };
  }

  /**
   * Encode humidity mode settings
   * @param {boolean} enabled - Enable humidity mode
   * @param {number|string} detection - Detection sensitivity (0-3 or 'low'/'medium'/'high'/'custom')
   * @param {number} rpm - Fan speed in RPM
   * @returns {Buffer} - Encoded data
   */
  static encodeHumidity(enabled, detection, rpm) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt8(this.validateDetection(detection), 1);
    buffer.writeUInt16LE(this.validateRpm(rpm), 2);
    return buffer;
  }

  /**
   * Parse light and VOC sensor data (4 bytes)
   * Format: <?B?B (light_enabled, light_detection, voc_enabled, voc_detection)
   * @param {Buffer} data - Raw data
   * @returns {object} - Parsed data
   */
  static parseLightVoc(data) {
    if (data.length < 4) {
      throw new Error(`Light/VOC data must be at least 4 bytes, got ${data.length}`);
    }
    const lightDetection = data.readUInt8(1);
    const vocDetection = data.readUInt8(3);
    return {
      light: {
        enabled: Boolean(data.readUInt8(0)),
        detection: Constants.DETECTION_LEVELS[lightDetection] || 'medium',
        detectionRaw: lightDetection,
      },
      voc: {
        enabled: Boolean(data.readUInt8(2)),
        detection: Constants.DETECTION_LEVELS[vocDetection] || 'medium',
        detectionRaw: vocDetection,
      },
    };
  }

  /**
   * Encode light and VOC sensor settings
   * @param {boolean} lightEnabled - Enable light sensor
   * @param {number|string} lightDetection - Light detection sensitivity
   * @param {boolean} vocEnabled - Enable VOC sensor
   * @param {number|string} vocDetection - VOC detection sensitivity
   * @returns {Buffer} - Encoded data
   */
  static encodeLightVoc(lightEnabled, lightDetection, vocEnabled, vocDetection) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt8(lightEnabled ? 1 : 0, 0);
    buffer.writeUInt8(this.validateDetection(lightDetection), 1);
    buffer.writeUInt8(vocEnabled ? 1 : 0, 2);
    buffer.writeUInt8(this.validateDetection(vocDetection), 3);
    return buffer;
  }

  /**
   * Parse timer mode data (5 bytes)
   * Format: <B?BH (duration, delay_enabled, delay_minutes, rpm)
   * @param {Buffer} data - Raw data
   * @returns {object} - Parsed data
   */
  static parseTimer(data) {
    if (data.length < 5) {
      throw new Error(`Timer data must be at least 5 bytes, got ${data.length}`);
    }
    return {
      duration: data.readUInt8(0),
      delay: {
        enabled: Boolean(data.readUInt8(1)),
        minutes: data.readUInt8(2),
      },
      rpm: data.readUInt16LE(3),
    };
  }

  /**
   * Encode timer mode settings
   * @param {number} duration - Duration in minutes
   * @param {boolean} delayEnabled - Enable delay
   * @param {number} delayMinutes - Delay in minutes
   * @param {number} rpm - Fan speed in RPM
   * @returns {Buffer} - Encoded data
   */
  static encodeTimer(duration, delayEnabled, delayMinutes, rpm) {
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(this.validateTime(duration), 0);
    buffer.writeUInt8(delayEnabled ? 1 : 0, 1);
    buffer.writeUInt8(this.validateTime(delayMinutes), 2);
    buffer.writeUInt16LE(this.validateRpm(rpm), 3);
    return buffer;
  }

  /**
   * Parse airing mode data (5 bytes)
   * Format: <?2BH (enabled, on_time, off_time, rpm)
   * @param {Buffer} data - Raw data
   * @returns {object} - Parsed data
   */
  static parseAiring(data) {
    if (data.length < 5) {
      throw new Error(`Airing data must be at least 5 bytes, got ${data.length}`);
    }
    return {
      enabled: Boolean(data.readUInt8(0)),
      onTime: data.readUInt8(1),
      offTime: data.readUInt8(2),
      rpm: data.readUInt16LE(3),
    };
  }

  /**
   * Encode airing mode settings
   * @param {boolean} enabled - Enable airing mode
   * @param {number} onTime - On time in minutes
   * @param {number} offTime - Off time in minutes
   * @param {number} rpm - Fan speed in RPM
   * @returns {Buffer} - Encoded data
   */
  static encodeAiring(enabled, onTime, offTime, rpm) {
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt8(this.validateTime(onTime), 1);
    buffer.writeUInt8(this.validateTime(offTime), 2);
    buffer.writeUInt16LE(this.validateRpm(rpm), 3);
    return buffer;
  }

  /**
   * Parse pause mode data (2 bytes)
   * Format: <?B (enabled, duration)
   * @param {Buffer} data - Raw data
   * @returns {object} - Parsed data
   */
  static parsePause(data) {
    if (data.length < 2) {
      throw new Error(`Pause data must be at least 2 bytes, got ${data.length}`);
    }
    return {
      enabled: Boolean(data.readUInt8(0)),
      duration: data.readUInt8(1),
    };
  }

  /**
   * Encode pause mode settings
   * @param {boolean} enabled - Enable pause mode
   * @param {number} duration - Duration in minutes
   * @returns {Buffer} - Encoded data
   */
  static encodePause(enabled, duration) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt8(this.validateTime(duration), 1);
    return buffer;
  }

  /**
   * Parse boost mode data (5 bytes)
   * Format: <?2H (enabled, rpm, duration_seconds)
   * @param {Buffer} data - Raw data
   * @returns {object} - Parsed data
   */
  static parseBoost(data) {
    if (data.length < 5) {
      throw new Error(`Boost data must be at least 5 bytes, got ${data.length}`);
    }
    return {
      enabled: Boolean(data.readUInt8(0)),
      rpm: data.readUInt16LE(1),
      duration: data.readUInt16LE(3), // in seconds
    };
  }

  /**
   * Encode boost mode settings
   * @param {boolean} enabled - Enable boost mode
   * @param {number} rpm - Fan speed in RPM
   * @param {number} durationMinutes - Duration in minutes (converted to seconds internally)
   * @returns {Buffer} - Encoded data
   */
  static encodeBoost(enabled, rpm, durationMinutes) {
    const buffer = Buffer.alloc(5);
    buffer.writeUInt8(enabled ? 1 : 0, 0);
    buffer.writeUInt16LE(this.validateRpm(rpm), 1);
    buffer.writeUInt16LE(this.validateTime(durationMinutes) * 60, 3); // Convert to seconds
    return buffer;
  }

  /**
   * Encode temporary speed command (write-only)
   * @param {number} rpm - Fan speed in RPM
   * @returns {Buffer} - Encoded data
   */
  static encodeTemporarySpeed(rpm) {
    const buffer = Buffer.alloc(3);
    buffer.writeUInt8(1, 0); // Always enabled when setting
    buffer.writeUInt16LE(this.validateRpm(rpm), 1);
    return buffer;
  }

  /**
   * Parse authentication code
   * @param {Buffer} data - Raw auth data
   * @returns {string|null} - Authentication code or null if invalid
   */
  static parseAuthCode(data) {
    if (!data || data.length === 0) {
      return null;
    }

    // Check if it's a 4-byte binary code
    if (data.length === 4) {
      return data.toString('hex');
    }

    // Check if it's an 8-character hex string
    const hexString = data.toString('utf8').trim();
    if (/^[0-9a-fA-F]{8}$/.test(hexString)) {
      return hexString.toLowerCase();
    }

    return null;
  }

  /**
   * Encode authentication code for writing
   * @param {string} authCode - 8-character hex string
   * @returns {Buffer} - Encoded auth data
   */
  static encodeAuthCode(authCode) {
    if (!authCode || authCode.length !== 8) {
      throw new Error('Authentication code must be 8 hex characters');
    }
    return Buffer.from(authCode, 'hex');
  }

}

module.exports = IntelliventParser;
