## 1. Project Convergence

- [x] 1.1 Add a runtime-level B-to-C synchronous re-entry regression covering the scene hook, host events, and persistence URI.
- [x] 1.2 Enable latest-wins project delivery and validate internal consumer ownership before and after re-entrant calls.

## 2. Renderer Restoration

- [x] 2.1 Add mock success/throw regressions for active face/mip and separated default/target state.
- [x] 2.2 Add a real-browser WebGL regression for nonuniform pixels, vertical orientation, and non-default cube target restoration.
- [x] 2.3 Restore the default framebuffer and prior target state in the correct order.

## 3. Timeline Re-entry

- [x] 3.1 Add a two-listener endpoint time regression that exposes the stale outer payload.
- [x] 3.2 Enable latest-wins time delivery.

## 4. Thumbnail Retry Budget

- [x] 4.1 Add a mixed success/failure thumbnail regression.
- [x] 4.2 Persist at most three attempts per shot until generation changes.

## 5. Verification And Delivery

- [x] 5.1 Validate OpenSpec, run focused red/green cycles, sync CodeGraph, and inspect affected tests.
- [x] 5.2 Run typecheck, lint, all unit tests, build, and all browser tests.
- [x] 5.3 Commit, push PR #6 head, verify the remote SHA, and report the four mappings.
