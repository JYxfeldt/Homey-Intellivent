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
- Use **Repair** on the device (see below) before deleting and re-adding it

### Repair

Device → Repair forces a fresh Bluetooth scan, rebuilds the connection and
re-reads the authentication code. Use it when a fan is stuck unavailable, or
after putting a fan into pairing mode so that control (Boost, modes, fan speed)
starts working.

If a fan stays unreachable while other Bluetooth devices keep working, see
"Homey's Bluetooth scanning stops" below - Repair cannot fix that.

## Notes for developers

### Repair views: `onHomeyReady` is never called

The SDK documents custom pairing and repair views as receiving the `Homey`
object through a global `onHomeyReady(Homey)` callback. **In a repair view on
Homey Pro 13.4.1 that callback never fires.** The view's script runs normally -
inline styles apply, inline `onclick` handlers work - but `onHomeyReady` is not
invoked, so a view that waits for it appears fully rendered and does nothing.

The object *is* available: it shows up as a global `Homey` shortly after the
view loads. `drivers/intellivent-sky/repair/repair.html` therefore accepts it
from either route and reports which one won in its status line. On this Homey
it consistently reports `[global]` - the poller, not the documented callback.

Worth reporting to Athom. Until then, do not rely on `onHomeyReady` alone in a
repair view.

Two related traps in the same area:

- Repair views live in `drivers/<driver_id>/repair/`, **not** in `pair/`. The
  docs describe them as "custom pairing views", which is misleading. Homey's
  own CLI keeps them separate (`HomeyCompose.js`, `appPairPath` vs
  `appRepairPath`). Wrong folder gives `unknown_error_getting_file`.
- `homey app validate` does not check repair views at all. A view id with no
  file behind it passes validation at `publish` level. Verify by inspecting
  `.homeybuild/` after a build.
- The Homey Style Library is not loaded automatically in these views, so
  classes like `homey-button-primary-full` render unstyled. Style them
  yourself; this view uses inline styles.

### Homey's Bluetooth scanning stops

Homey's BLE manager periodically stops discovering new peripherals. A full scan
returns only the peripherals that are already connected, and stays that way
until Homey is restarted - restarting the app is not enough
([athombv/homey-apps-sdk-issues#454](https://github.com/athombv/homey-apps-sdk-issues/issues/454)).

Consequences worth knowing:

- Already-connected devices keep working. On this Homey the Plejd app holds one
  permanent connection to a mesh node and is unaffected, while these fans - which
  need a scan for every reconnect - are locked out. A working Bluetooth device
  elsewhere in the house does **not** mean Bluetooth is healthy.
- The app detects the signature (six consecutive near-empty scans) and changes
  the device's unavailable message accordingly.
- Nothing an app can do recovers it. Prevention is the only lever, which is why
  the app holds its connection for as long as possible and never disconnects
  just to reconnect.

Proactive session recycling was tried and removed: with an 8-minute recycle the
bathroom fan lasted 83 minutes; with recycling disabled it was still connected
after 8 hours 21 minutes.

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
