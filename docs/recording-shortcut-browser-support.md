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

The independent unit fixture additionally rejects and refuses to persist `Ctrl+Shift+B`, `Ctrl+Shift+O`, `Ctrl+Shift+D`, `Alt+E`, `Alt+F`, `Alt+Space`, `Cmd+D`, `Cmd+Alt+B`, `Cmd+H`, `Cmd+M`, `Cmd+Space`, `Cmd+Shift+B`, `Cmd+Shift+D`, `Cmd+Shift+P`, `Cmd+Shift+[`, and `Cmd+Shift+]` without deriving expectations from the production policy table. Every case asserts an explicit validation error, `save=false`, zero storage-adapter writes, and zero `localStorage` writes.

## Reserved Alias Audit

The policy pairs the browser actions that expose more than one documented or review-required shortcut so an alias cannot bypass validation:

- Chrome/Windows browser menu: `Alt+E` and `Alt+F`.
- Chrome/macOS bookmark manager: `Cmd+Alt+B`, alongside the bookmark-bar shortcut `Cmd+Shift+B`.
- Safari/macOS previous and next tab: `Cmd+Shift+[` and `Cmd+Shift+]`; Safari's official shortcut guide also lists `Control+Shift+Tab` and `Control+Tab`, which are already rejected by the generic `Ctrl+Tab` / `Ctrl+Shift+Tab` policy entries.

Safari's official macOS shortcut guide was reachable during this audit and confirms the tab aliases above. The Chrome Help shortcut page was not reachable from this environment after two attempts, so the two Chrome aliases are covered against the review-required matrix and independent regression fixture rather than claimed as a live official-page verification.

## Setup Note

The first Firefox command could not launch because `firefox-1538` was not installed. `npx playwright install firefox webkit` installed Firefox `153.0` and WebKit `26.5`; the unchanged Firefox and WebKit suites then passed. There is no remaining missing-browser boundary in this environment.

## Residual Boundary

Playwright WebKit validates the WebKit engine on Windows, not the shipping Safari browser or macOS system-level Command-key routing. Actual Safari/macOS menu integration remains a manual compatibility boundary; policy-level Command combinations are covered by independent unit fixtures.
