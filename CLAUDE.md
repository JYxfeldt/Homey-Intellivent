# Project Rules

## Versioning

For every change made to this project, increment the patch version (third octet) by one in `app.json`.

Example: `0.1.3` → `0.1.4` → `0.1.5`

## Changelog

Every version bump gets a matching entry in `.homeychangelog.json`, keyed by the new version, in the same commit. Publishing runs headless in GitHub Actions and fails if the current `app.json` version has no entry.

- Write one or two short sentences for app users, not developers: what changed for them.
- Include both `en` and `sv`.
- If nothing changes for users (docs, tooling, tests), say so, e.g. "Maintenance: … No change to how the app works."

```json
"0.4.12": {
  "en": "Short description of what changed for the user.",
  "sv": "Kort beskrivning av vad som ändrats för användaren."
}
```
