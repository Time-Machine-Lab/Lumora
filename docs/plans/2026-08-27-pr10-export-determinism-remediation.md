# PR #10 Export Determinism Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Remove the PR #10 export release blockers by isolating editor shortcuts and project sessions, bounding MediaRecorder finalization, rejecting non-deterministic capture, and closing the remaining PNG, focus, accessibility, frame allocation, and framing defects.

**Architecture:** Keep the existing dependency-injected MediaRecorder path, but make its contract fail closed when manual frame requests or real-time deadlines cannot be honored. Bind every UI export operation to the editor's `{projectUri, sessionToken}` identity and revalidate before each stateful step, download, and playhead restoration. Reuse one active-scene camera validator for WebM plans and PNG export.

**Tech Stack:** React 19, TypeScript, Three.js, MediaRecorder/CanvasCaptureMediaStreamTrack, Vitest, Testing Library, Playwright.

---

### Task 1: Deterministic Export Domain Contract

**Files:**
- Modify: `packages/studio/test/preview-export.test.ts`
- Modify: `packages/studio/src/export/preview-export.ts`

1. Add failing tests for cumulative shot-boundary allocation, required `requestFrame()`, sustained deadline misses, abort/error/timeout races during recorder finalization, and cleanup/retry behavior.
2. Run `npm test --workspace @lumora/studio -- preview-export.test.ts` and confirm the new assertions fail against the fixed PR head.
3. Add the shared active-scene camera validator, cumulative allocation, deadline budget, and a single bounded finalization race.
4. Re-run the focused domain tests until green.

### Task 2: Session-Bound Workspace And Accessibility

**Files:**
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `packages/studio/test/lumora-studio.test.tsx`
- Modify: `packages/studio/src/components/export/ExportWorkspace.tsx`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`

1. Add failing tests proving idle/running export blocks editor shortcuts, PNG rejects cameras outside the active scene, stale project tasks cannot capture/download/restore, cancellation and failure restore WebM focus, and `aria-busy` excludes the live region.
2. Run the focused UI tests and confirm failures are behavioral rather than fixture errors.
3. Add a capture-phase export shortcut guard, pass the editor session token into the keyed workspace, and validate freshness around every asynchronous or externally re-entrant operation.
4. Scope busy semantics to an operation-controls region and focus the primary WebM action after cancellation/failure.
5. Re-run the focused UI tests until green.

### Task 3: Exact 480p Framing

**Files:**
- Modify: `packages/studio/test/editor-viewport-capture.test.ts`
- Modify: `packages/studio/src/components/editor/frame-capture.ts`

1. Add a failing pixel-level assertion for exact 16:9 content rendered into 854x480 without a one-sided black column.
2. Run the focused capture test and verify the old integer rounding produces the asymmetric border.
3. Center the fractional fit rectangle so rasterization distributes unavoidable sub-pixel coverage symmetrically.
4. Re-run capture tests until green.

### Task 4: Browser Regression Coverage

**Files:**
- Modify: `e2e/export.spec.ts`

1. Add Chromium tests for idle/running keyboard isolation, finalization cancellation without download, project close/reopen invalidation, deadline failure, strict playable duration, focus restoration, and 480p edge pixels.
2. Run `npm run e2e -- e2e/export.spec.ts` and fix only product defects reproduced by those scenarios.

### Task 5: Full Verification And Delivery

1. Run focused unit and Chromium tests, then complete unit/Chromium, lint, typecheck, build, OpenSpec strict validation, boundary smoke, package smoke, license consistency, and `git diff --check`.
2. Review the diff for privacy, media-track cleanup, focus, and editor workflow regressions.
3. Commit on `origin/agent/frontend/tml-54-preview-export`, push the existing PR branch, and verify local/remote/PR heads agree when credentials permit.
4. Post one Multica result comment with exact pass/fail/skip counts, PR URL/base/head, residual environment limits, and handoff for independent review.
