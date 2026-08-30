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

## Round 3 hard-gate evidence

The reviewer's annotated `round3-before` images are preserved unchanged. The matching `round3-after` images are generated from the corrected branch by:

```sh
npx playwright test e2e/tml-563-screenshots.spec.ts --project=chromium
```

The capture test asserts the measured failure condition before writing each image: modal count and unique accessible IDs, Fit canvas containment, 44px shot actions, disjoint 60fps keyframe targets with correct center ownership, document-level inert/focus, mixed-modal Escape order, single-row toolbar geometry, and portrait timeline containment.

| Failure state and viewport | Before | After |
| --- | --- | --- |
| Background Studio dispatches `Ctrl+K`, 1440x900 | [Before](round3-before/hold-dual-ctrlk-scope.png) | [After](round3-after/hold-dual-ctrlk-scope.png) |
| Two command palettes expose duplicate IDs, 1440x900 | [Before](round3-before/hold-dual-palette-ids.png) | [After](round3-after/hold-dual-palette-ids.png) |
| Fit loses the full duration after a 0.1s shot, 375x667 | [Before](round3-before/hold-fit-overview-loss-375x667.png) | [After](round3-after/hold-fit-overview-loss-375x667.png) |
| One zoom-out clips selected-shot actions, 375x667 | [Before](round3-before/hold-shot-actions-clipped-375x667.png) | [After](round3-after/hold-shot-actions-clipped-375x667.png) |
| Adjacent 60fps keyframes overlap, 375x667 | [Before](round3-before/tml-563-keyframes-60fps-overlap-375x667.png) | [After](round3-after/tml-563-keyframes-60fps-overlap-375x667.png) |
| Overwrite confirmation allows host-sibling focus, 1440x900 | [Before](round3-before/hold-overwrite-host-focus.png) | [After](round3-after/hold-overwrite-host-focus.png) |
| Mixed modal Escape closes the lower dialog first, 1440x900 | [Before](round3-before/hold-mixed-modal-escape-order.png) | [After](round3-after/hold-mixed-modal-escape-order.png) |
| Studio 1240 toolbar wraps at host 1580x768 | [Before](round3-before/toolbar-studio-1240-host-1580x768.png) | [After](round3-after/toolbar-studio-1240-host-1580x768.png) |
| Studio 1241 toolbar jumps at host 1581x768 | [Before](round3-before/toolbar-studio-1241-host-1581x768.png) | [After](round3-after/toolbar-studio-1241-host-1581x768.png) |
| Expanded host log clips the timeline, 375x667 | [Before](round3-before/portrait-log-open-375x667.png) | [After](round3-after/portrait-log-open-375x667.png) |

The related Studio `1080/1081` boundary is captured at [1420x768](round3-after/toolbar-studio-1080-host-1420x768.png) and [1421x768](round3-after/toolbar-studio-1081-host-1421x768.png); both remain in the same compact single-row mode.

An additional Chromium regression loads 60 consecutive 60fps keyframes and checks both the default zoom and the minimum zoom. Dense groups stay within two 44px rows, keep the track label and shot lane visible, and expose every grouped frame through repeated activation of the cluster target.
