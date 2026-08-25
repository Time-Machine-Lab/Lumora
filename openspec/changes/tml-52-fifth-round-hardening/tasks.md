## 1. Thumbnail Freshness

- [x] 1.1 Add active-scene, render-generation, deferred-loader, and transient-null regression tests.
- [x] 1.2 Include active scene and render-content generation in thumbnail invalidation.
- [x] 1.3 Cache only successful data URLs and bound retries per generation.

## 2. Viewport Capture

- [x] 2.1 Add aspect-ratio and renderer-state restoration tests for bound-camera capture.
- [x] 2.2 Implement fixed-aspect offscreen capture and PNG encoding without visible-canvas rendering.

## 3. Reentrancy

- [x] 3.1 Add nested B-to-C project-open and endpoint time-listener restart regressions.
- [x] 3.2 Carry session ownership in project events and reject stale deliveries.
- [x] 3.3 Revalidate endpoint state after time emission and return final controller time.

## 4. Browser Acceptance

- [x] 4.1 Add portal computed-style assertions and restore theme variables on the portal wrapper.
- [x] 4.2 Replace seek-based AC1 convergence with two natural endpoint playbacks and strict comparisons.

## 5. Verification And Delivery

- [x] 5.1 Run affected tests, sync CodeGraph, and inspect affected-test coverage.
- [x] 5.2 Run typecheck, lint, all unit tests, build, and all browser tests.
- [x] 5.3 Commit, push PR #6 head, verify the remote SHA, and report all eight mappings.
