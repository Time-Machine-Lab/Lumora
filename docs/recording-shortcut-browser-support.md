# Recording Shortcut Browser Support

Evidence date: 2026-08-30

Environment: Windows build `26200.6584`, Node `>=20`, Playwright `1.62.1`.

## Automated Matrix

| Browser target | Version | Command | Result |
| --- | --- | --- | --- |
| Microsoft Edge | `152.0.4191.53` | `$env:PLAYWRIGHT_CHANNEL='msedge'; npx playwright test e2e/recording-shortcut.spec.ts --project=chromium` | 3/3 passed |
| Chrome for Testing | `151.0.7922.34` (`chromium v1234`) | `npx playwright test e2e/recording-shortcut.spec.ts --project=chromium` | 3/3 passed |
| Firefox | `153.0` (`firefox v1538`) | `npx playwright test e2e/recording-shortcut.spec.ts --project=firefox` | 3/3 passed after installing the pinned browser |
| WebKit | `26.5` (`webkit v2336`) | `npx playwright test e2e/recording-shortcut.spec.ts --project=webkit` | 3/3 passed |

Each project runs the same acceptance scenarios:

1. The default recording shortcut works and a browser-reserved shortcut reports an error, disables save, and does not write local storage.
2. Accepting `beforeunload` during an active recording loses the uncommitted samples and restores the pre-recording IndexedDB/rendered timeline fingerprint.
3. A stopped and saved recording closes without a warning, then restores the same track IDs, target paths, keyframe times, and persisted keyframe values after reopening.

The independent unit fixture additionally rejects and refuses to persist `Ctrl+Shift+B`, `Ctrl+Shift+O`, `Ctrl+Shift+D`, `Alt+F`, `Alt+Space`, `Cmd+D`, `Cmd+H`, `Cmd+M`, `Cmd+Space`, `Cmd+Shift+B`, `Cmd+Shift+D`, and `Cmd+Shift+P` without deriving expectations from the production policy table.

## Setup Note

The first Firefox command could not launch because `firefox-1538` was not installed. `npx playwright install firefox webkit` installed Firefox `153.0` and WebKit `26.5`; the unchanged Firefox and WebKit suites then passed. There is no remaining missing-browser boundary in this environment.

## Residual Boundary

Playwright WebKit validates the WebKit engine on Windows, not the shipping Safari browser or macOS system-level Command-key routing. Actual Safari/macOS menu integration remains a manual compatibility boundary; policy-level Command combinations are covered by independent unit fixtures.
