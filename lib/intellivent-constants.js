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
// Values match pyfreshintellivent sensors.py _MODES (verified against the device protocol)
const MODE_MAP = {
  0: 'off',
  6: 'pause',
  16: 'constant_speed',
  34: 'light',
  35: 'timer',
  49: 'humidity',
  52: 'voc',
  103: 'boost',
};

// Detection sensitivity wire values (write path, all channels): 1=low, 2=medium, 3=high
// Mirrors pyfreshintellivent helpers.detection_string_as_int
const DETECTION_ENCODE = {
  low: 1,
  medium: 2,
  high: 3,
};

// Read-path decode differs per channel (mirrors pyfreshintellivent helpers.detection_int_as_string):
const DETECTION_DECODE_REGULAR = { 1: 'low', 2: 'medium', 3: 'high' }; // humidity
const DETECTION_DECODE_NO_LOW = { 1: 'medium', 2: 'medium', 3: 'high' }; // light (device has no "low")
const DETECTION_DECODE_REVERSED = { 1: 'high', 2: 'medium', 3: 'low' }; // VOC (reversed scale)

// Airing write payload requires this constant in byte 1 (pyfreshintellivent parser.airing_write)
const AIRING_MAGIC = 26;

// RPM limits
const MIN_RPM = 800;
const MAX_RPM = 2400;
const DEFAULT_RPM = 1200;

// Connection settings
const POLL_INTERVAL = 20000; // 20 s - keepalive poll: the fan drops idle links within minutes, and a peripheral-initiated drop wedges Homey's BLE manager until a Homey reboot (observed twice 2026-08-18). Keeping the link busy prevents both.
const RECONNECT_DELAY = 5000; // 5 seconds before reconnecting
const MAX_RECONNECT_ATTEMPTS = 3; // Maximum reconnection attempts

// Homey's BLE layer gives service discovery a fixed ~10 s window before it
// throws "Timeout waiting for ServicesResolved". These fans regularly need
// ~16 s to resolve their full GATT database, so a single call can never
// succeed. Retrying ON THE OPEN CONNECTION works because BlueZ keeps
// resolving in the background - each retry is another 10 s window against
// progress already made. Disconnecting instead would discard that progress.
const SERVICE_DISCOVERY_ATTEMPTS = 4;

// Hard ceiling on one find+connect+discover cycle, which runs holding the
// app-wide BLE lock. Homey's connect() can hang indefinitely on a weak
// peripheral (observed >3 min at rssi -81); without this the radio is starved
// for every other device. Must comfortably exceed a normal worst case:
// scan + connect + SERVICE_DISCOVERY_ATTEMPTS * ~10 s.
const CONNECT_TIMEOUT = 75000;

// Rate limiting settings
const MAX_CONNECTION_FAILURES = 5; // Max failures before extended cooldown
const CONNECTION_FAILURE_WINDOW = 60000; // 1 minute - only recent failures count (was 5 min == POLL_INTERVAL, which tripped the limiter on every cycle)
const EXTENDED_COOLDOWN = 30000; // 30 s cooldown after max failures
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
  DETECTION_ENCODE,
  DETECTION_DECODE_REGULAR,
  DETECTION_DECODE_NO_LOW,
  DETECTION_DECODE_REVERSED,
  AIRING_MAGIC,

  // Limits
  MIN_RPM,
  MAX_RPM,
  DEFAULT_RPM,

  // Timeouts
  POLL_INTERVAL,
  RECONNECT_DELAY,
  MAX_RECONNECT_ATTEMPTS,
  SERVICE_DISCOVERY_ATTEMPTS,
  CONNECT_TIMEOUT,

  // Rate limiting
  MAX_CONNECTION_FAILURES,
  CONNECTION_FAILURE_WINDOW,
  EXTENDED_COOLDOWN,
  AUTH_REGEN_COOLDOWN,
};
