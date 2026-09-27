# Fresh Intellivent for Homey

Control your Fresh Intellivent ventilation fans via Bluetooth using your Homey Pro.

## Supported Devices

- Intellivent Sky

## Features

- **On/Off Control**: Off pauses the fan; On ends the pause and the fan resumes its own setup (constant speed only if nothing else is set up)
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
2. Go to Devices > Add Device > Fresh Intellivent
3. Put your Intellivent device in pairing mode, as the first pairing screen describes (see Pairing below)
4. Select your device from the list

## Flow Cards

### Triggers
- Mode changed (tokens: `mode`, the stable id such as `humidity`, and
  `mode_name`, the translated name for notifications)
- Humidity changed (fires when humidity has moved at least 1 % since it
  last fired)

### Conditions
- Mode is/is not...

### Actions
- Set mode
- Set fan speed
- Start boost
- Configure humidity detection

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
put the fan back into pairing mode and run Repair on the device. The settings
page shows the code masked; `00000000` there means read-only.

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

If the device says Homey's Bluetooth scanning has stopped, Repair cannot fix
that: update Homey to 13.5.0 or later, or restart Homey (see "Homey's Bluetooth
scanning stops" below).

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

On Homey 13.4.1 and earlier, Homey's BLE manager could stop discovering new
peripherals until Homey was restarted: scans returned only the peripherals that
were already connected, so a fan that dropped its link could never reconnect
([athombv/homey-apps-sdk-issues#454](https://github.com/athombv/homey-apps-sdk-issues/issues/454)).
Homey 13.5.0 fixes this. After 18 days on 13.5.0 without a reboot the failure had
not recurred, and dropped fans reconnected on their own
([measurements](docs/athom-issue-454-comment-draft.md)).

The app still supports older Homey versions, so it still detects the failure
(six consecutive scans that see at most one peripheral) and then shows a message
asking the user to restart Homey.

## Credits

The app manifest credits contributors, and `THIRD_PARTY_NOTICES.txt` carries the upstream license.
Based on the protocol reverse-engineering from [pyfreshintellivent](https://github.com/LaStrada/pyfreshintellivent) (upstream by LaStrada, fork at [JYxfeldt/pyfreshintellivent](https://github.com/JYxfeldt/pyfreshintellivent)).

## License

MIT License

## Changelog

See [`.homeychangelog.json`](.homeychangelog.json) for the version history shown on the Homey App Store page.
