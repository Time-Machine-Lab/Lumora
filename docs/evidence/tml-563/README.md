# TML-563 UI/UX Review Evidence

The `before` images are the original reviewer's `HOLD` matrix. The `after` images are generated from this branch by:

```sh
npx playwright test e2e/tml-563-screenshots.spec.ts --project=chromium
```

Each after image uses a fresh browser context so project persistence and runtime locks cannot leak between captures.

| ID | State and viewport | Before | After |
| --- | --- | --- | --- |
| 01 | Editor, selected cube, 1440x900 | [Before](before/01-desktop-editor-1440x900.png) | [After](after/01-desktop-editor-1440x900.png) |
| 01a | Narrow embedded editor, selected cube, 1024x768 | [Before](before/01a-desktop-editor-1024x768.png) | [After](after/01a-desktop-editor-1024x768.png) |
| 02 | Plugin manager, 1440x900 | [Before](before/02-desktop-plugin-manager-1440x900.png) | [After](after/02-desktop-plugin-manager-1440x900.png) |
| 03 | Command palette, 1440x900 | [Before](before/03-desktop-command-palette-1440x900.png) | [After](after/03-desktop-command-palette-1440x900.png) |
| 04 | Storyboard, 1440x900 | [Before](before/04-desktop-storyboard-1440x900.png) | [After](after/04-desktop-storyboard-1440x900.png) |
| 05 | Export workspace, 1440x900 | [Before](before/05-desktop-export-1440x900.png) | [After](after/05-desktop-export-1440x900.png) |
| 06a | Mobile editor before selection, 375x667 | [Before](before/06a-mobile-editor-before-selection-375x667.png) | [After](after/06a-mobile-editor-before-selection-375x667.png) |
| 06 | Mobile editor after selection, 375x667 | [Before](before/06-mobile-editor-375x667.png) | [After](after/06-mobile-editor-375x667.png) |
| 07 | Mobile plugin manager, 375x667 | [Before](before/07-mobile-plugin-manager-375x667.png) | [After](after/07-mobile-plugin-manager-375x667.png) |
| 08 | Mobile storyboard, 375x667 | [Before](before/08-mobile-storyboard-375x667.png) | [After](after/08-mobile-storyboard-375x667.png) |
| 09 | Mobile landscape editor, 667x375 | [Before](before/09-mobile-landscape-editor-667x375.png) | [After](after/09-mobile-landscape-editor-667x375.png) |
| 10 | Mobile landscape export, 667x375 | [Before](before/10-mobile-landscape-export-667x375.png) | [After](after/10-mobile-landscape-export-667x375.png) |

The focused regression suite also checks WCAG A/AA violations, modal focus containment and restoration, embed-width layout, collapsed host logs, and nonblank desktop/mobile WebGL canvas pixels.
