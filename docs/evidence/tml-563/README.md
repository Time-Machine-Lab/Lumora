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
| 11 | Host sibling isolation, plugin modal, 1440x900 | [Before](before/11-portal-host-isolation-1440x900.png) | [After](after/11-portal-host-isolation-1440x900.png) |
| 12 | ShadowRoot opener focus restored, 1440x900 | [Before](before/12-shadow-root-focus-restore-1440x900.png) | [After](after/12-shadow-root-focus-restore-1440x900.png) |
| 13a | 900px Studio boundary (1240x768 host) | [Before](before/13-responsive-boundary-1240x768.png) | [After](after/13-responsive-boundary-1240x768.png) |
| 13b | 901px Studio boundary (1241x768 host) | [Before](before/13-responsive-boundary-1241x768.png) | [After](after/13-responsive-boundary-1241x768.png) |
| 13c | 1100px Studio boundary (1440x768 host) | [Before](before/13-responsive-boundary-1440x768.png) | [After](after/13-responsive-boundary-1440x768.png) |
| 13d | 1101px Studio boundary (1441x768 host) | [Before](before/13-responsive-boundary-1441x768.png) | [After](after/13-responsive-boundary-1441x768.png) |
| 14 | Mobile landscape with host log expanded, 667x375 | [Before](before/14-mobile-landscape-log-open-667x375.png) | [After](after/14-mobile-landscape-log-open-667x375.png) |
| 15 | Mobile fit zoom with 0.1s shot controls, 375x667 | [Before](before/15-mobile-fit-shot-controls-375x667.png) | [After](after/15-mobile-fit-shot-controls-375x667.png) |
| 16 | Mobile keyframe target lanes, 375x667 | [Before](before/16-mobile-keyframe-overlap-375x667.png) | [After](after/16-mobile-keyframe-overlap-375x667.png) |
| 17 | Mobile storyboard close/delete controls, 375x667 | [Before](before/17-mobile-storyboard-controls-375x667.png) | [After](after/17-mobile-storyboard-controls-375x667.png) |
| 18 | Plugin transition focus, 1440x900 | [Before](before/18-plugin-transition-focus-1440x900.png) | [After](after/18-plugin-transition-focus-1440x900.png) |
| 19 | Two-Studio top-modal stack after Escape, 1440x900 | [Before](before/19-multiple-modal-stack-1440x900.png) | [After](after/19-multiple-modal-stack-1440x900.png) |

The focused regression suite also checks WCAG A/AA violations, document-level host isolation, deep ShadowRoot focus restoration, two-Studio modal ordering, stable plugin-toggle focus, 900/901 and 1100/1101 container geometry, mobile shot/keyframe hitbox geometry, expanded landscape logs, and nonblank desktop/mobile WebGL canvas pixels.
