## 1. Counterexamples

- [x] 1.1 Add a core two-listener settings:changed regression proving the later listener receives only the nested final settings.
- [x] 1.2 Add a hook regression where applying project B's fps synchronously opens C and all timeline mirrors finish on C.
- [x] 1.3 Run both regressions against the old implementation and confirm the expected stale payload/session failures.

## 2. Implementation

- [x] 2.1 Make settings:changed latest-wins.
- [x] 2.2 Revalidate project payload freshness before and after each synchronous event-emitting timeline operation.
- [x] 2.3 Cover null, session-change, ordinary-update, and deleted-recording-camera callback branches without expanding scope.

## 3. Verification And Delivery

- [x] 3.1 Validate OpenSpec strictly, sync CodeGraph, and inspect the focused impact surface.
- [x] 3.2 Run typecheck, lint, all unit tests, production build, and all browser tests.
- [x] 3.3 Commit, push PR #6 head, verify the remote SHA, and report the blocker mapping and registered non-goals.
