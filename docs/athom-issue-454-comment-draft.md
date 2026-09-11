# Draft comment for athombv/homey-apps-sdk-issues#454

**Status: not posted.** For review before publishing.

Issue: https://github.com/athombv/homey-apps-sdk-issues/issues/454

---

## Draft

Firmware 13.5.0 lists under BLE: *"Fixes a number of issues that could cause BLE
to stop working as expected until a reboot is performed."* Reporting measurements
from the same setup that produced the original report, in case it helps confirm.

**Setup:** Homey Pro (Early 2023), `homey5q`, updated to 13.5.0 on 2026-09-07 at
17:52 UTC (`rebootReason: reboot-ota`). Two Fresh Intellivent Sky fans on an
SDK v3 app; one at roughly -58 dBm, one at roughly -81 dBm. No Homey reboot
since the update — same `bootId` throughout, uptime 4 d 5 h at the time of
writing.

**Scanning.** A discovery sweep from Developer Tools now returns **32
peripherals with RSSI**. For comparison, on 13.4.1 a healthy sweep returned
around 15, and a wedged one returned 1–2 — and the ones it did return were
exactly the peripherals already connected, which is what made the state so hard
to recognise from inside an app.

**Connection lifetime, strong fan.** Unbroken since the update:
**4 days 5 hours and counting**, verified from Insights rather than a single
sample — the `measure_rpm` log has a fractional hourly average for every hour
in the window, meaning fresh samples arrived continuously with no
carry-forward gaps.

On 13.4.1 the same fan, same position, same app:

| | Lifetime |
|---|---|
| 13.4.1, reconnecting every 8 min by design | 83 min |
| 13.4.1, holding one connection | 8 h 21 min |
| 13.4.1, holding one connection | 9 h 50 min |
| **13.5.0** | **101 h, still connected** |

**Recovery without a reboot — the part that matters most here.** The original
report's core finding was that once a peripheral dropped the session, Homey
could never reconnect to that peripheral until the whole Homey was rebooted; an
app restart did not help. That behaviour is gone. The weak fan still loses its
link regularly, but it now **comes back on its own**. Insights shows it
reconnecting unattended at least three times since the update (2026-09-09
~20:00, 2026-09-10 ~13:00 and ~20:00 UTC), with no reboot and no app restart in
between. On 13.4.1 that never happened once across several weeks.

### What this does not show

- One Homey, one household, no controlled A/B. The comparison is against
  measurements taken on the same hardware before the update, not a matched
  experiment.
- The weak fan is still unreliable: roughly 7 hours connected out of the last
  101. That looks like a link-budget problem at -81 dBm rather than anything
  platform-side — it is heard in scans, but sporadically, and it fails at
  connection establishment rather than at discovery. Mentioning it only so the
  numbers above are not read as "everything is fixed".
- I cannot confirm *which* of the issues in the changelog applied here, only
  that the failure mode described in this issue has not recurred in four days
  of continuous use, on a setup that previously reproduced it within hours.

Happy to run anything specific if it would help close this out.
