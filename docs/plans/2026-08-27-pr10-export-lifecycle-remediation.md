# PR #10 Export Lifecycle Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Make WebM duration deterministic, serialize every export operation, suppress stale session/operation work, preserve native keyboard activation, and replace weak export evidence with frame-accurate visual regressions.

**Architecture:** Keep the dependency-injected browser MediaRecorder path, but add a quantized terminal frame at `totalFrames / fps` and an operation-validity callback checked at every asynchronous or externally reentrant boundary. Replace the component's independent WebM/plugin busy flags with one monotonic operation generation and one active-operation state, invalidated on unmount, project/session changes, and plugin removal. Render perspective cameras with the actual integer viewport aspect so 854x480 output preserves geometry without letterbox edge artifacts.

**Tech Stack:** React 19, TypeScript, Three.js, MediaRecorder/CanvasCaptureMediaStreamTrack, Vitest, Testing Library, Playwright.

---

### Task 1: Quantized WebM terminal frame and recorder token barrier

**Files:**
- Modify: `packages/studio/test/preview-export.test.ts`
- Modify: `packages/studio/src/export/preview-export.ts`

1. Add failing unit assertions that six content frames request a seventh terminal duplicate after the `250ms` quantized deadline, without advancing progress or rendering another source frame.
2. Add a failing microtask-reentry test whose validity callback becomes false while `renderFrame()` is awaiting, and assert no `requestFrame()` occurs afterward.
3. Run `npm test -w @lumora/studio -- preview-export.test.ts` and confirm both new assertions fail for the old implementation.
4. Add `isOperationCurrent` to `PreviewRecordingOptions`; validate it before/after render, after progress callbacks and waits, before the terminal request, and before recorder stop.
5. Wait to the absolute `totalFrames / fps` deadline, request one duplicate terminal frame, and wait one task turn so Chromium observes the final timestamp before stopping.
6. Re-run the focused test and keep all existing recorder cleanup/failure tests green.

### Task 2: Unified export operation generation and session barriers

**Files:**
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `packages/studio/src/components/export/ExportWorkspace.tsx`

1. Add failing tests proving a pending plugin disables WebM/PNG/manifest/close and cannot be overlapped by WebM or a second plugin.
2. Add failing tests proving unmount, plugin removal, and a stale completion suppress download/status/focus changes and never update a newer operation.
3. Add reentry tests that replace or close the project synchronously inside `pause()` and `seek()`; assert no later seek, frame capture, frame request, download, or playhead restoration.
4. Run the focused test and confirm failures reflect the independent `running`/`pluginBusy` state and missing post-call guards.
5. Implement one monotonic generation ref and one active operation state for manifest, PNG, WebM, and plugin exporters. Every operation captures `{uri, sessionGeneration, operationGeneration}` and validates it before state mutation or shared side effects.
6. Abort/invalidate on unmount, project/session invalidation, and contribution/plugin removal. Pass the operation validator into `recordPreviewWebm` and guard immediately after every `pause()`/`seek()`.
7. Re-run `export-workspace.test.tsx` and the combined export unit suite.

### Task 3: Native Space activation and complete shortcut matrix

**Files:**
- Modify: `packages/studio/test/lumora-studio.test.tsx`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Modify: `e2e/export.spec.ts`

1. Add a failing integration test focused on the closed-workspace export button: Space must open export without toggling playback; Enter remains native.
2. Extend the export-open shortcut matrix with Backspace, Ctrl+Y, and Ctrl+Shift+Z.
3. Add the real Chromium `.press('Space')` regression before the workspace opens.
4. Run the focused unit/Chromium tests and confirm Space fails under the old global handler.
5. Move the native interactive-element guard ahead of global editor shortcut dispatch while preserving the special Ctrl+K input behavior and export-open shortcut isolation.
6. Re-run focused tests.

### Task 4: Integer viewport projection geometry

**Files:**
- Modify: `packages/studio/test/editor-viewport-capture.test.ts`
- Modify: `packages/studio/src/components/editor/frame-capture.ts`
- Modify: `e2e/export.spec.ts`

1. Add a failing unit assertion that a perspective camera uses `854 / 480` while rendering a full-width 480p viewport and restores its prior aspect afterward.
2. Add a browser-level geometry assertion based on a stable foreground silhouette ratio rather than populated edge pixels alone.
3. Run the focused unit test and confirm the camera still uses exact `16 / 9`.
4. Set perspective projection to the actual fitted integer viewport aspect; keep project aspect only for deciding the fitted viewport.
5. Re-run unit and PNG Chromium tests.

### Task 5: Playable duration, visual shot order, retry, and untracked camera evidence

**Files:**
- Modify: `packages/studio/test/preview-export.test.ts`
- Modify: `packages/studio/test/camera-drive-routing.test.tsx`
- Modify: `e2e/export.spec.ts`
- Modify: `docs/export-and-release.md`

1. Complete the finalization-timeout test with a second successful recording attempt.
2. Use an untracked camera in drive routing and assert the actual Three camera node changes, not only project form values.
3. Extend WebM inspection to decode frames from each shot segment and compare stable visual signatures against per-shot PNG references or mutually distinct expected signatures.
4. Change duration assertions to the quantized target `totalFrames / fps` with a one-frame-derived tolerance, and separately assert the source-timeline quantization error for three `0.2s` shots.
5. Run focused Chromium export tests, including repeated short-export duration checks.
6. Document terminal-frame duration semantics, output-aspect projection, and unified operation cancellation.

### Task 6: Full gates and fixed PR head

**Files:**
- Verify all changed files and repository metadata.

1. Run focused export unit and Chromium tests.
2. Run full unit tests at default concurrency; if the known round9 deep test flakes, record it and run isolated plus single-worker confirmation.
3. Run full Chromium, lint, typecheck, build, OpenSpec strict, boundary smoke, package/install smoke, license consistency, and `git diff --check`.
4. Commit the scoped remediation with the issue key and push the resulting HEAD to `agent/frontend/tml-54-preview-export`.
5. Independently read local HEAD, remote branch head, and PR #10 head; confirm all match and base `6536d3b440783b65debc2a559067a32accc1f309` is an ancestor.
6. Confirm the worktree is clean and report the PR URL, fixed SHA, commit summary, all gate results, warnings, skips, and any environment limitation.
