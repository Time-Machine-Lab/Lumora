# PR #10 Terminal Frame, Focus, and Race Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Produce a new fixed PR #10 head whose real WebM artifacts retain the quantized terminal frame and whose export workspace closes the remaining keyboard, focus, persistence, and stale-operation gaps.

**Architecture:** Replace real-time `canvas.captureStream()`/MediaRecorder timing with WebCodecs frames carrying explicit microsecond PTS values and a WebM muxer finalized only after `VideoEncoder.flush()`. Encode an unchanged terminal frame at `N / fps`, keep the existing session and operation generations, add microtask checkpoints around externally re-entrant `seek()` and capture calls, and restore focus from the initiating control with an enabled-action fallback. Browser evidence writes downloaded WebM files to Playwright output and probes packets, final PTS, and container duration with `ffprobe`.

**Tech Stack:** React 19, TypeScript, WebCodecs, `webm-muxer`, Vitest + Testing Library, Playwright Chromium, FFmpeg `ffprobe`, OpenSpec.

---

### Task 1: Make terminal-frame completion observable

**Files:**
- Modify: `packages/studio/test/preview-export.test.ts`
- Modify: `packages/studio/src/export/preview-export.ts`

1. Extend the encoder harness with encoded timestamp/duration capture and add a failing test requiring an explicit terminal frame at `N / fps`.
2. Add cancellation, encoder-error, empty-output, pending-flush, timeout, and retry cases; assert encoder closure on every path.
3. Run `npx vitest run packages/studio/test/preview-export.test.ts` and retain the failing terminal timestamp/finalization evidence from the reviewed implementation.
4. Add a dependency-injected WebCodecs encoder session and WebM muxer, encode explicit timestamps, then race `flush()` against abort, stale ownership, and a bounded timeout before muxer finalization.
5. Re-run the focused preview-export tests and keep all finalization paths green.

### Task 2: Prove real WebM packets, PTS, duration, and persisted visual order

**Files:**
- Modify: `e2e/export.spec.ts`

1. Add Node-side helpers that save a downloaded WebM under `testInfo.outputPath()` and parse `ffprobe -show_packets -show_format -of json` output.
2. Add a failing 14-frame/24fps Chromium case requiring 15 video packets including the terminal packet, final PTS and container duration at `14/24`, with a tolerance below half a frame; add a longer 30fps case with the same contract.
3. Run the two artifact cases on the reviewed head and retain the first failing packet/PTS/duration evidence.
4. Re-run after Task 1 until both cases pass repeatedly without Playwright retries.
5. Replace the weak three-shot setup with a persisted/reopened project containing three separately positioned cameras and strongly distinct rendered views. Export each reference PNG, sample the corresponding decoded WebM segment, and require the nearest-reference order `[0, 1, 2]` with separation margins.

### Task 3: Preserve native export-button activation while isolating host shortcuts

**Files:**
- Modify: `packages/studio/test/lumora-studio.test.tsx`
- Modify: `packages/studio/src/components/Toolbar.tsx`
- Modify: `e2e/export.spec.ts`

1. Change the host-listener regression to require that Space/Enter on the focused export button preserve `defaultPrevented === false` while never reaching a later `window` listener.
2. Run the focused LumoraStudio test and confirm the current toolbar button leaks the event.
3. Stop keyboard propagation on the export trigger itself for Space and Enter without calling `preventDefault()`, leaving native click activation intact.
4. Add a browser host-listener assertion to the native Space test and verify the workspace opens exactly once without toggling playback or invoking the host shortcut.

### Task 4: Restore focus to the initiating export control with resilient fallback

**Files:**
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `packages/studio/src/components/export/ExportWorkspace.tsx`

1. Add failing tests for plugin failure/cancellation restoring the still-mounted plugin button, and plugin removal falling back to the first enabled operation when WebM is unsupported or frame capture is unavailable.
2. Run the focused tests and confirm the current unconditional primary-WebM focus fails on disabled/removed controls.
3. Capture the initiating element when an operation begins. On cancellation/error, focus it if still connected and enabled; otherwise focus the first enabled operation button, then the close button.
4. Defer the focus decision until React has committed contribution removal, cancel the pending focus timer on unmount, and re-run the focus tests.

### Task 5: Close seek re-entry and stale-completion races

**Files:**
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `packages/studio/src/components/export/ExportWorkspace.tsx`
- Modify: `e2e/export.spec.ts`

1. Add failing PNG/WebM tests for synchronous close, different-URI open, same-URI reopen, and microtask session replacement from inside `seek()`; require no stale capture, frame request, download, restoration, or status write.
2. Add a failing test where plugin removal permits a new operation, the old plugin promise then resolves, and the old completion must not clear the new busy state or status.
3. Add microtask checkpoints and ownership checks after externally re-entrant seek/capture/restoration calls while retaining the monotonic operation-generation guard.
4. Extend the browser same-URI invalidation case to instrument `VideoEncoder.close()`, require zero legacy capture streams, and assert no stale download.
5. Run focused workspace and Chromium race tests until green.

### Task 6: Documentation and release gates

**Files:**
- Modify: `docs/export-and-release.md`
- Modify: `docs/plans/2026-08-27-pr10-terminal-frame-focus-race-remediation.md`

1. Document explicit WebCodecs timestamps, terminal-frame encoding, the flush/muxer finalization barrier, and the product-level packet/PTS acceptance rule.
2. Run focused Vitest and Chromium tests, then full default-concurrency Vitest and full Chromium with zero retries.
3. Run `npm run lint`, `npm run typecheck`, `npm run build`, `npx openspec validate --all --strict --no-interactive`, `npm run smoke:pack:boundary`, `npm run smoke:pack`, `npm run licenses:generate`, and `git diff --check`.
4. Confirm license generation leaves no unexpected diff and record all first-run failures or environment limitations.
5. Commit on the isolated checkout, push `HEAD` to `agent/frontend/tml-54-preview-export`, and verify local HEAD, remote branch head, and PR #10 head agree with `1dc7f39af28dfd398119b49cb1808ec0a4d17739` as an ancestor.
