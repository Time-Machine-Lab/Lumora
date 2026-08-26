## 1. Provider-Neutral Contract

- [x] 1.1 Add a dynamic storyboard model catalog type with fresh discovery/submission validation.
- [x] 1.2 Add stable authentication and browser-network error codes with fixed host summaries.
- [x] 1.3 Prove static Mock catalogs and immutable public snapshots do not regress.

## 2. OpenAI-Compatible Plugin

- [x] 2.1 Add safe endpoint/model validation and non-sensitive persistence.
- [x] 2.2 Keep the optional API key in runtime memory and send it only as a Bearer header.
- [x] 2.3 Implement Chat Completions prompting, envelope/content parsing, timeout, abort, and no-retry error mapping.
- [x] 2.4 Add settings, connection testing, CORS guidance, loading, validation, success, error, and key-clear states.
- [x] 2.5 Abort requests and clear credentials on disable while restoring only endpoint/model on enable.

## 3. Studio And Browser Acceptance

- [x] 3.1 Register the plugin without changing Mock as the default provider.
- [x] 3.2 Generate, edit, and adopt three route-backed compatible shots with configured model lineage.
- [x] 3.3 Verify no API key appears in browser persistence, exported project data, event logs, or public errors.
- [x] 3.4 Verify authentication mapping/no retry and desktop/mobile settings and generation layouts.

## 4. Verification And Delivery

- [x] 4.1 Pass strict OpenSpec validation and inspect the final protocol/privacy boundaries.
- [x] 4.2 Pass root typecheck, lint, all Vitest, production build, Chromium Playwright, pack smoke, boundary smoke, and diff check.
- [ ] 4.3 Commit and push the independent branch, open a TML-297 PR without close intent, and report base/head/dependency/results.
