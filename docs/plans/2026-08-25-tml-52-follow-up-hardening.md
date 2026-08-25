# TML-52 Follow-up Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Close the post-merge TML-52 recording re-entry blocker and four severe timeline/runtime findings without expanding the four general follow-up risks.

**Architecture:** Recording commands use a hook-owned operation generation plus editor session and camera identity checks around synchronous timeline events. Camera drive admission shares the Studio root keyboard scope, and the overwrite modal disables both new input and in-flight drive motion. Core timeline processing replaces recursive RDP with an iterative worklist, rejects oversized imported timeline data before deep validation, and uses Map/Set indexes for linear reference and reorder checks.

**Tech Stack:** TypeScript, React 19 hooks, Three.js, Vitest, Testing Library, OpenSpec, CodeGraph, Playwright.

---

### Task 1: Recording action re-entry

**Files:**
- Modify: `packages/studio/test/use-timeline-session.test.tsx`
- Modify: `packages/studio/src/hooks/use-timeline-session.ts`

1. Add three real hook tests where `state:changed` synchronously opens project B during begin, resume, and pause.
2. Run the focused hook suite and verify stale React recording/playing state fails before implementation.
3. Add a monotonic recording operation generation. Capture `{generation, sessionToken, cameraId}` for each action and revalidate after every synchronous timeline call before writing React state.
4. Invalidate active operations when project/session cancellation stops the recorder.
5. Re-run the hook suite and keep all three counterexamples green.

### Task 2: Modal and multi-instance camera drive isolation

**Files:**
- Create: `packages/studio/src/components/studio-keyboard-scope.ts`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Modify: `packages/studio/src/components/editor/EditorViewport.tsx`
- Create: `packages/studio/test/camera-drive-routing.test.tsx`

1. Add real component tests with distinct Three scene roots: one KeyW/KeyS event inside Studio A must not move Studio B; opening overwrite confirmation with disabled camera tracks must clear existing momentum and reject drive keys.
2. Run the new suite and verify both tests fail against the merged implementation.
3. Share Studio root registration/admission between shell shortcuts and camera drive, require drive handlers to respect `defaultPrevented`, and pass the shell root to the viewport.
4. Treat `overwritePending` as a hard drive-disabled state and include `DRIVE_KEY_CODES` in modal capture blocking.
5. Re-run the component suite.

### Task 3: Stack-safe long recording simplification

**Files:**
- Modify: `packages/core/test/track-math.test.ts`
- Modify: `packages/core/src/scene/track-math.ts`

1. Add an 8,000-point alternating-path regression that preserves endpoints and completes without `RangeError`.
2. Run it against recursive RDP and record the stack-overflow RED result.
3. Replace recursive traversal with an explicit interval stack and a kept-index bitmap, then emit retained samples in source order.
4. Re-run all track math tests.

### Task 4: Timeline import budgets and linear validation

**Files:**
- Modify: `packages/core/test/project-package.test.ts`
- Modify: `packages/core/test/scene-editor-tracks-shots.test.ts`
- Modify: `packages/core/src/project/package.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/scene/validate.ts`
- Modify: `packages/core/src/editor/scene-editor.ts`

1. Add pre-deep-validation counterexamples for track count, shot count, per-track keyframes, and total keyframes using injected small limits; expect `too-large` even when over-budget entries are structurally invalid.
2. Add deterministic complexity guards that reject object-array `.find()` during timeline reference validation and shot-id-array `.includes()` during reorder.
3. Run focused package/editor tests and record the RED results.
4. Extend `PackageParseLimits` and public constants, count timeline budgets immediately after migration, and return actionable `too-large` errors before asset decode/schema traversal.
5. Build one object-id Map for track/shot reference validation and one current-shot Set for reorder membership.
6. Re-run focused core suites.

### Task 5: Governance, full verification, and delivery

**Files:**
- Create: `openspec/changes/tml-52-follow-up-hardening/**`

1. Strict-validate OpenSpec, sync CodeGraph, and inspect affected tests.
2. Run typecheck, lint, all unit tests, production build, and all Playwright tests.
3. Request an independent read-only code review and resolve all Critical/Important findings.
4. Commit on `agent/tml-52-follow-up-hardening`, push a new remote branch, create a new TML-52 follow-up PR, and verify its head SHA.
