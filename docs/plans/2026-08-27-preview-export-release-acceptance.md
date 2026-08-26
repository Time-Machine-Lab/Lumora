# Preview Export And Release Acceptance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Deliver deterministic storyboard PNG/manifest export and a cancellable 720p/24fps WebM preview workflow, then record the executable and documentary evidence needed for Lumora MVP release review.

**Architecture:** Keep browser encoding behind a small dependency-injected controller so codec checks, ordered shot timing, cancellation, and resource cleanup can be tested without a real encoder. Reuse the existing timeline seek path and Three.js offscreen capture path for every exported frame, and expose the workflow as an unframed Studio workspace so failures never replace or mutate project state.

**Tech Stack:** React 19, TypeScript, Three.js, MediaRecorder/CanvasCaptureMediaStreamTrack, Vitest, Testing Library, Playwright.

---

### Task 1: Export Domain Contract

**Files:**
- Create: `packages/studio/src/export/preview-export.ts`
- Create: `packages/studio/test/preview-export.test.ts`

1. Write failing tests for ordered shot selection, missing/invalid cameras, unsupported browser APIs/codecs, manifest projection, WebM progress, cancellation, recorder failure, and track cleanup.
2. Run `npm test --workspace @lumora/studio -- preview-export.test.ts` and confirm failures are caused by the missing module.
3. Implement typed validation, manifest creation, capability detection, and the dependency-injected MediaRecorder loop.
4. Re-run the focused test file and keep all failure paths non-mutating.

### Task 2: Resolution-Aware Frame Rendering

**Files:**
- Modify: `packages/studio/src/components/editor/frame-capture.ts`
- Modify: `packages/studio/src/components/editor/EditorViewport.tsx`
- Modify: `packages/studio/test/editor-viewport-capture.test.ts`

1. Write failing tests that request exact 1280x720 output and assert renderer/camera state restoration after success and failure.
2. Run the focused capture tests and confirm the requested-size behavior is absent.
3. Add a reusable render-to-canvas path while preserving the existing thumbnail data URL API.
4. Register an export-frame bridge beside the thumbnail bridge and re-run capture tests.

### Task 3: Export Workspace

**Files:**
- Create: `packages/studio/src/components/export/ExportWorkspace.tsx`
- Create: `packages/studio/test/export-workspace.test.tsx`

1. Write failing UI tests for defaults (all shots, 720p, 24fps), range selection, codec warning, manifest/PNG download, progress, cancel, retry, and plugin exporter failure isolation.
2. Run the focused UI tests and confirm the component is missing.
3. Implement the workspace with semantic form controls, live progress, disabled/busy states, focus restoration, and local error presentation.
4. Re-run the focused UI tests.

### Task 4: Studio Integration And Styling

**Files:**
- Modify: `packages/studio/src/components/Toolbar.tsx`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Modify: `packages/studio/src/lumora.css`
- Modify: `packages/studio/test/lumora-studio.test.tsx`

1. Write a failing integration test for opening/closing the export workspace without changing the current project.
2. Add the toolbar command, mutually exclusive workspace state, capture bridge wiring, and responsive full-screen styles.
3. Verify keyboard access, readable names, focus behavior, mobile layout, and no nested-card structure.
4. Re-run Studio and workspace tests.

### Task 5: Browser Acceptance

**Files:**
- Create: `e2e/export.spec.ts`
- Modify: `playwright.config.ts` only if an additional named browser project is required.

1. Add a short real Chromium WebM export test that verifies the download MIME/signature, non-zero size, ordered progress, and editor usability after completion.
2. Add unsupported-codec instrumentation proving no recorder or download is created.
3. Add cancel instrumentation proving recording tracks stop and the project remains editable.
4. Cover the release main path with existing import, camera, timeline, storyboard, persistence, and export controls while collecting page/console errors.

### Task 6: Release Evidence And Documentation

**Files:**
- Modify: `README.md`
- Create: `docs/export-and-release.md`
- Create: `docs/THIRD_PARTY_NOTICES.md`
- Create: `scripts/generate-third-party-notices.mjs`

1. Document WebM capability requirements, MP4 plugin-only policy, Safari degradation, export cancellation/cleanup, and embedding/plugin boundaries.
2. Add a reproducible third-party license inventory generated from `package-lock.json`.
3. Record the 100-object/1-million-triangle benchmark recipe and leave the device-specific pass/fail gate explicitly pending Q-003.
4. Add a release checklist covering Chrome/Edge stable and previous stable, Safari fallback, keyboard/focus/contrast, security, build, package smoke, and rollback checks.

### Task 7: Verification And Handoff

1. Run `npm run lint`.
2. Run `npm run typecheck`.
3. Run `npm run test`.
4. Run `npm run build`.
5. Run `npm run e2e -- e2e/export.spec.ts` and the release main-flow specs.
6. Run `npm run smoke:pack` if the preceding gates pass.
7. Inspect the final diff for generated or unrelated churn. This Multica role must not commit, push, or create a PR without explicit project-manager authorization.
