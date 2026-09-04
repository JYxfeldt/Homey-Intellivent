# Bug report for athombv/homey-apps-sdk-issues

**Submitted:** https://github.com/athombv/homey-apps-sdk-issues/issues/457

## Title

`onHomeyReady(Homey)` is never called in a custom repair view (Homey Pro 13.4.1)

---

## Summary

In a custom **repair** view, the documented `onHomeyReady(Homey)` callback is
never invoked. The view's script runs normally otherwise, and the `Homey`
object *is* reachable — it appears as a global `Homey` shortly after the view
loads — but the callback that is supposed to deliver it never fires.

The result is a repair view that renders completely and does nothing, with no
error anywhere.

## Environment

| | |
|---|---|
| Model | Homey Pro (Early 2023), `homey5q` |
| Firmware | 13.4.1 |
| Node | v24.19.0 |
| SDK | v3 |
| CLI | homey 4.4.2 |
| Manifest | hand-written `app.json` (no `.homeycompose`) |
| View type | `repair` (see scope below) |

## Expected

Per [Custom Pairing Views](https://apps.developer.homey.app/advanced/custom-views/custom-pairing-views),
a custom view defines `onHomeyReady(Homey)`; the first argument is a `Homey`
instance, and the view calls `Homey.ready()` to become visible.
[Repairing](https://apps.developer.homey.app/the-basics/devices/pairing) states
that custom pairing views can also be used for repairing, so the same contract
should apply.

## Actual

`onHomeyReady` is never called. Everything else in the view works:

- the markup renders, and `data-i18n` attributes are resolved
- inline styles apply
- an inline `onclick` handler fires and calls a global function in the view's
  own `<script>`

So the script is parsed and executed — but the callback is not invoked, and any
code that waits for it never runs. A global `Homey` object does become
available: a poller that checks for `window.Homey` finds it and can then use
`Homey.emit()`, `Homey.on()`, `Homey.__()` and `Homey.ready()` normally.

In a view instrumented to report which route delivered the object, the result
is `[global]` on every attempt. `[onHomeyReady]` has never been observed.

## Minimal reproduction

**1. Driver manifest** — add a repair view:

```json
{
  "repair": [
    { "id": "repair" }
  ]
}
```

**2. `drivers/<driver_id>/repair/repair.html`**

```html
<div id="status">script has not run</div>
<button type="button" onclick="showState()">Show state</button>

<script type="application/javascript">
  var received = null;

  function setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  // Documented route
  function onHomeyReady(Homey) {
    received = 'onHomeyReady';
    setStatus('ready via onHomeyReady');
    Homey.ready();
  }

  // Undocumented route: watch for a global Homey object instead
  var tries = 0;
  var timer = setInterval(function () {
    if (received) { clearInterval(timer); return; }
    if (window.Homey) {
      clearInterval(timer);
      received = 'global';
      setStatus('ready via global Homey');
      window.Homey.ready();
    } else if (++tries > 100) {
      clearInterval(timer);
      setStatus('no Homey object at all');
    }
  }, 200);

  function showState() {
    alert('route=' + received + ' typeof window.Homey=' + typeof window.Homey);
  }
</script>
```

**3. `drivers/<driver_id>/driver.js`**

```javascript
async onRepair(session, device) {
  session.setHandler('do_something', async () => ({ ok: true }));
}
```

**4.** Open the device in the Homey mobile app → Repair.

**Observed:** the view shows `ready via global Homey`, and the button reports
`route=global typeof window.Homey=object`.

**Expected:** `ready via onHomeyReady`.

Replacing the `function onHomeyReady` declaration with an explicit
`window.onHomeyReady = function (Homey) { ... }` makes no difference.

## Why this is easy to miss

The failure is silent and looks like an app bug rather than a platform one:

- Nothing is logged, on either the app side or the client side.
- `data-i18n` is still resolved, so the view looks fully populated. A view
  whose only interactive element is created inside `onHomeyReady` therefore
  renders its complete instructions with no control at all, which reads as
  "the developer forgot the button".
- If the control is in the markup instead, it renders and responds to clicks —
  but every call into `Homey` fails, because the view never received it.

## Workaround

Accept the object from either route and use whichever arrives first:

```javascript
function onHomeyReady(Homey) { init(Homey); }        // documented
setInterval(function () {                             // fallback
  if (window.Homey) init(window.Homey);
}, 200);
```

## Scope

Only **repair** views were tested. This app's pairing flow uses the built-in
`list_devices` and `add_devices` templates, so there was no custom *pair* view
to compare against. Whether the same applies to custom pair views is unknown,
and worth checking as part of triage — if pair views are unaffected, the
difference between the two code paths is probably the answer.

## Side note: `homey app validate` does not check repair views

Related, and part of why this took a long time to pin down:
`homey app validate --level publish` performs no checks on repair views at all.

Demonstrated by pointing the repair view at an id with no corresponding file:

```json
"repair": [ { "id": "this_file_does_not_exist" } ]
```

`homey app validate --level publish` still reports
`App validated successfully against level 'publish'`.

At runtime the same manifest fails with `unknown_error_getting_file` and a
blank view. Validating the existence of repair view files would catch both that
mistake and the related one below.

**Also worth documenting:** repair view files must live in
`drivers/<driver_id>/repair/`, not `drivers/<driver_id>/pair/`. The
documentation describes repair views only as "custom pairing views", and the
custom pairing views page states that views live in the `pair` folder, which
reads as though repair views belong there too. Homey's own CLI keeps them
separate (`HomeyCompose.js`: `appPairPath` vs `appRepairPath`), and putting the
file in `pair/` produces the same `unknown_error_getting_file` with no hint at
the cause.

## Context

Found while adding a repair flow to an SDK v3 BLE app
([JYxfeldt/Homey-Intellivent](https://github.com/JYxfeldt/Homey-Intellivent)).
The repair view is at `drivers/intellivent-sky/repair/repair.html` if a
complete working example is useful.
