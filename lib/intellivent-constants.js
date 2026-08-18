'use strict';

/**
 * BLE Service and Characteristic UUIDs for Intellivent Sky devices
 * Based on: https://github.com/JYxfeldt/pyfreshintellivent
 */

// Device Information Service (Standard BLE)
const UUID_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';

// Standard Device Information Characteristics
const MODEL_NUMBER = '00002a24-0000-1000-8000-00805f9b34fb';
const FIRMWARE_VERSION = '00002a26-0000-1000-8000-00805f9b34fb';
const HARDWARE_VERSION = '00002a27-0000-1000-8000-00805f9b34fb';
const SOFTWARE_VERSION = '00002a28-0000-1000-8000-00805f9b34fb';
const MANUFACTURER_NAME = '00002a29-0000-1000-8000-00805f9b34fb';

// Intellivent Sky Custom Characteristics
const DEVICE_NAME = 'b85fa07a-9382-4838-871c-81d045dcc2ff';
const DEVICE_STATUS = '528b80e8-c47a-4c0a-bdf1-916a7748f412';
const AUTH = '4cad343a-209a-40b7-b911-4d9b3df569b2';
const HUMIDITY = '7c4adc01-2f33-11e7-93ae-92361f002671';
const LIGHT_VOC = '7c4adc02-2f33-11e7-93ae-92361f002671';
const CONSTANT_SPEED = '7c4adc03-2f33-11e7-93ae-92361f002671';
const TIMER = '7c4adc04-2f33-11e7-93ae-92361f002671';
const AIRING = '7c4adc05-2f33-11e7-93ae-92361f002671';
const PAUSE = '7c4adc06-2f33-11e7-93ae-92361f002671';
const BOOST = '7c4adc07-2f33-11e7-93ae-92361f002671';
const TEMPORARY_SPEED = '7c4adc08-2f33-11e7-93ae-92361f002671';

// Device identification
const DEVICE_NAME_FILTER = 'Intellivent';

// Mode mappings (from sensor data byte)
const MODE_MAP = {
  0: 'off',
  1: 'pause',
  2: 'constant_speed',
  3: 'light',
  4: 'timer',
  5: 'humidity',
  6: 'voc',
  7: 'boost',
};

// Detection sensitivity levels
const DETECTION_LEVELS = {
  0: 'low',
  1: 'medium',
  2: 'high',
  3: 'custom',
};

// RPM limits
const MIN_RPM = 800;
const MAX_RPM = 2400;
const DEFAULT_RPM = 1200;

// Connection settings
const CONNECTION_TIMEOUT = 30000; // 30 seconds
const POLL_INTERVAL = 300000; // 5 minutes - fallback heartbeat when notifications unavailable
const RECONNECT_DELAY = 5000; // 5 seconds before reconnecting
const MAX_RECONNECT_ATTEMPTS = 3; // Maximum reconnection attempts

// Rate limiting settings
const MAX_CONNECTION_FAILURES = 5; // Max failures before extended cooldown
const CONNECTION_FAILURE_WINDOW = 300000; // 5 minutes - window to track failures
const EXTENDED_COOLDOWN = 60000; // 1 minute cooldown after max failures
const AUTH_REGEN_COOLDOWN = 300000; // 5 minutes between auth code regenerations

module.exports = {
  // Service UUIDs
  UUID_SERVICE,

  // Standard Device Info
  MODEL_NUMBER,
  FIRMWARE_VERSION,
  HARDWARE_VERSION,
  SOFTWARE_VERSION,
  MANUFACTURER_NAME,

  // Custom Characteristics
  DEVICE_NAME,
  DEVICE_STATUS,
  AUTH,
  HUMIDITY,
  LIGHT_VOC,
  CONSTANT_SPEED,
  TIMER,
  AIRING,
  PAUSE,
  BOOST,
  TEMPORARY_SPEED,

  // Discovery
  DEVICE_NAME_FILTER,

  // Mappings
  MODE_MAP,
  DETECTION_LEVELS,

  // Limits
  MIN_RPM,
  MAX_RPM,
  DEFAULT_RPM,

  // Timeouts
  CONNECTION_TIMEOUT,
  POLL_INTERVAL,
  RECONNECT_DELAY,
  MAX_RECONNECT_ATTEMPTS,

  // Rate limiting
  MAX_CONNECTION_FAILURES,
  CONNECTION_FAILURE_WINDOW,
  EXTENDED_COOLDOWN,
  AUTH_REGEN_COOLDOWN,
};
