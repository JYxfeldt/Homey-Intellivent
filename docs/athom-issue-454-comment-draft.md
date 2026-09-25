# Comment for athombv/homey-apps-sdk-issues#454

**Status: posted 2026-09-25.**

Issue: https://github.com/athombv/homey-apps-sdk-issues/issues/454
Comment: https://github.com/athombv/homey-apps-sdk-issues/issues/454#issuecomment-5840982124

Thread state when this was written: still open, no labels, last activity was the
diagnostic report posted on 2026-09-04. Nobody had reported 13.5.0 results, and
`machin-pl`'s question from 2026-08-24 — whether an app can recover the BLE
stack without rebooting the whole Homey — was still unanswered. The comment is
written to answer those two things rather than restate the original report.

---

## Comment

Following up on the diagnostic report I posted here on 4 September, now that
13.5.0 has been running for a while. Its changelog lists under BLE: *"Fixes a
number of issues that could cause BLE to stop working as expected until a reboot
is performed."* As far as I can tell nobody has reported back on it yet, so here
is what I measured. Short version: the specific failure mode this issue
describes has not recurred.

**Setup:** Homey Pro (Early 2023), `homey5q`, updated to 13.5.0 on 2026-09-07 at
17:52 UTC (`rebootReason: reboot-ota`). Two BLE fans on an SDK v3 app, one at
roughly -58 dBm and one at roughly -81 dBm. **No Homey reboot since the update:
same `bootId` throughout, uptime 18 days 5 hours at the time of writing.** The
13.4.1 figures below come from the same hardware, same app, same fan positions.

**Scanning.** A discovery sweep now returns **32 peripherals with RSSI**. On
13.4.1 a healthy sweep returned around 15, and a wedged one returned 1–2 — and
the 1–2 it did return were exactly the peripherals already connected. That is
what made the wedged state so hard to recognise from inside an app: discovery
succeeded and returned a plausible-looking result, so there was nothing to
detect except by noticing that everything else had vanished.

**Continuity, strong fan.** Over the last 14 days, the `measure_rpm` Insights
log has **a fractional hourly average for all 336 of 336 hourly buckets**
(2026-09-11T23:00 through 2026-09-25T22:00 UTC), with zero carry-forward gaps.
Homey's hourly buckets repeat the previous value when no sample arrives, so a
fractional average means samples actually landed in that hour and a flat integer
means silence. Fourteen days without a single silent hour, across a period that
includes one app reinstall.

For comparison, connection lifetimes measured on 13.4.1:

| | Lifetime |
|---|---|
| 13.4.1, reconnecting every 8 min by design | 83 min |
| 13.4.1, holding one connection | 8 h 21 min |
| 13.4.1, holding one connection | 9 h 50 min |

**Recovery without a reboot — the part that matters most here, and an answer to
@machin-pl's question.** The original finding was that once a peripheral dropped
the session, Homey could never reconnect to *that* peripheral until the whole
Homey was rebooted; restarting the app did not help. On 13.4.1 I could not find
any cheaper recovery than a reboot, and I did look — restarting the app,
disconnecting cleanly on `onUninit`, and proactively recycling the session from
the app side all failed to recover a wedged stack. (Proactive recycling was
actively harmful, incidentally: every recycle forces a reconnect, a reconnect
needs a scan, and scanning was the fragile part. 83 minutes of uptime with
recycling versus 8 h 21 min without.)

On 13.5.0 that behaviour is gone. The weak fan still loses its link regularly,
but it now **comes back on its own**: Insights shows it reconnecting unattended
on at least four separate occasions since the update, with no Homey reboot in
between. Three of those (2026-09-09 ~20:00, 2026-09-10 ~13:00 and ~20:00 UTC)
involved no app restart either. On 13.4.1 that never happened once across
several weeks.

So from an app developer's perspective the practical answer to "can an app
recover the BLE stack without rebooting Homey" seems to have changed from *no*
to *you no longer need to* — at least for this failure mode.

### What this does not show

- **336 fractional hours is not proof of an unbroken GATT session.** A
  reconnect that completes within the same hour looks identical in hourly
  Insights data. What it establishes is that no full hour passed without
  contact, and nothing stronger than that.
- **One Homey, one household, no controlled A/B.** The 13.4.1 numbers are
  earlier measurements on the same hardware, not a matched experiment.
- **The app code changed during the period.** I lowered the reconnect backoff
  cap from 5 minutes to 60 seconds on 2026-09-12, precisely because scanning no
  longer looked fragile. So this is not a clean platform-only comparison —
  faster retries plausibly contribute to the continuity figure.
- **The weak fan is still down**, 6.5 days now, since 2026-09-19 10:16 UTC.
  That looks like a link-budget problem at -81 dBm rather than anything
  platform-side: it is heard in scans but fails at connection establishment
  rather than at discovery, and it is a separate problem from the one this issue
  describes. Mentioning it so the numbers above are not read as "everything is
  fixed".
- I cannot confirm *which* of the changelog fixes applied here, only that the
  failure mode described in this issue has not recurred in 18 days of continuous
  use on a setup that previously reproduced it within hours.

Happy to run anything specific, or to send a fresh diagnostic report, if that
would help close this out.
