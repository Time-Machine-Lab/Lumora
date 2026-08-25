## 1. Counterexample

- [x] 1.1 Add the real hook regression: delete the only shot, then add project C's shot synchronously from time:changed.
- [x] 1.2 Assert same-session identity, duration 8, playing true, and no outer duplicate settings snapshot.
- [x] 1.3 Run the regression against the old implementation and confirm stale pause/settings behavior.

## 2. Implementation

- [x] 2.1 Add a dedicated duration operation generation to TimelineController.
- [x] 2.2 Revalidate the generation immediately after the internal seek() event boundary.
- [x] 2.3 Stop superseded outer duration calls before stale pause and settings emission.

## 3. Verification And Delivery

- [x] 3.1 Validate OpenSpec strictly, sync CodeGraph, and inspect the focused impact surface.
- [x] 3.2 Run typecheck, lint, all unit tests, production build, and all browser tests.
- [x] 3.3 Commit, push PR #6 head, verify the remote SHA, and report the blocker mapping and non-goals.
