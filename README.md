# Homey Intellivent Fresh

Control your Intellivent Fresh ventilation fans via Bluetooth using your Homey Pro.

## Supported Devices

- Intellivent Sky

## Features

- **On/Off Control**: Turn your ventilation fan on or off
- **Fan Speed Control**: Adjust fan speed from 800-2400 RPM
- **Multiple Operating Modes**:
  - Constant Speed: Run at a fixed RPM
  - Humidity: Automatically adjust based on humidity levels
  - Light: Activate based on light sensor
  - VOC: Activate based on air quality sensor
  - Timer: Run for a specified duration
  - Boost: High-speed mode for quick ventilation
  - Airing: Cycle between on/off periods
  - Pause: Temporarily stop the fan
- **Boost Button**: One tap on the device tile runs the fan at full speed for a
  set time. Speed and duration are configured per device under Settings > Boost
  (defaults: 2400 RPM for 15 minutes)
- **Sensor Readings**: Monitor temperature and humidity
- **Flow Support**: Integrate with Homey flows for automation

## Installation

1. Install the app from the Homey App Store
2. Go to Devices > Add Device > Intellivent Fresh
3. Put your Intellivent device in pairing mode (see Pairing below)
4. Select your device from the list

## Flow Cards

### Triggers
- Mode changed
- Humidity changed

### Conditions
- Mode is/is not...

### Actions
- Set mode
- Set fan speed (RPM)
- Start boost

## Pairing

To pair your Intellivent device:

1. Make sure your fan is powered on
2. Activate Bluetooth pairing mode on the fan's touch panel: press the on/off
   symbol once, then press and hold the light/air quality symbol for 8 seconds
   until it starts flashing (see the Intellivent Sky quick guide)
3. The device should appear in the Homey pairing list
4. Select the device and follow the pairing instructions

Note: the authentication code is only readable from the fan while it is in
pairing mode. If pairing completes but the device reports read-only mode,
put the fan back into pairing mode and re-pair.

## Troubleshooting

### Device not found during pairing
- Make sure the device is in pairing mode (LED should be blinking)
- Move Homey closer to the fan (Bluetooth range is typically 10 meters)
- Try restarting the Homey app

### Connection issues
- Ensure no other device is connected to the fan via Bluetooth
- Try re-pairing the device
- Check that the fan is powered on

## Credits

Based on the protocol reverse-engineering from [pyfreshintellivent](https://github.com/LaStrada/pyfreshintellivent) (upstream by LaStrada, fork at [JYxfeldt/pyfreshintellivent](https://github.com/JYxfeldt/pyfreshintellivent)).

## License

MIT License

## Changelog

### 1.0.0
- Initial release
- Support for Intellivent Sky devices
- Basic fan control (on/off, speed, modes)
- Temperature and humidity monitoring
- Flow support for automation
