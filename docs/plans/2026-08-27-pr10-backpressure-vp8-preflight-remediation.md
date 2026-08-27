# PR #10 Backpressure and VP8 Preflight Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Produce a new fixed PR #10 head that keeps long WebCodecs exports cancellable, bounds the encoder queue, verifies the active VP8 configuration before enabling export, and closes encoders when configuration fails.

**Architecture:** Extend `PreviewEncoderSession` with observable queue size and an abortable dequeue wait, then gate each encode against an exported queue limit and force a browser macrotask yield after a bounded number of frames. Model VP8 support as checking/supported/unsupported, derive the exact encoder configuration from resolution and frame rate, and ignore preflight completions that no longer own the current project session or selection. Keep the existing `{uri, sessionGeneration, operationGeneration}` barriers around every resumed wait and all download/playhead/status side effects.

**Tech Stack:** React 19, TypeScript, WebCodecs, `webm-muxer`, Vitest + Testing Library, Playwright Chromium, OpenSpec.

---

### Task 1: Specify bounded encoder flow control

**Files:**
- Modify: `packages/studio/test/preview-export.test.ts`
- Modify: `packages/studio/src/export/preview-export.ts`

1. Extend the encoder harness with controllable `encodeQueueSize` and dequeue promises.
2. Add failing tests that require queue waits before the configured limit is exceeded and require a real timer task yield even while the queue remains below the limit.
3. Add failing cancellation and stale-operation tests for both queue-wait and macrotask-yield resumptions, requiring no further render/encode/progress work and one encoder close.
4. Run `npx vitest run packages/studio/test/preview-export.test.ts` and retain the expected failures against the reviewed head.
5. Add exported queue/yield constants, an abortable `waitForQueueSize()` session contract, and an operation-aware wait helper.
6. Gate normal and terminal frames with the queue limit, yield at the bounded interval, and immediately recheck abort/operation ownership after each wait.
7. Re-run the focused test file until all backpressure, timing, cancellation, timeout, and retry cases pass.

### Task 2: Specify current-configuration VP8 support

**Files:**
- Modify: `packages/studio/test/preview-export.test.ts`
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `packages/studio/src/export/preview-export.ts`
- Modify: `packages/studio/src/components/export/ExportWorkspace.tsx`

1. Add failing contract tests for `VideoEncoder.isConfigSupported()` receiving VP8, selected dimensions, frame rate, bitrate, and latency mode; cover unsupported and rejected checks.
2. Add failing workspace tests for the initial checking state, unsupported/error reasons, disabled export before resolution, and out-of-order stale results after selection and session changes.
3. Run the focused Vitest files and confirm the constructor-only support check and immediately enabled button fail the new expectations.
4. Derive one VP8 `VideoEncoderConfig` for both preflight and `configure()`, and make support detection asynchronous without adding VP9 fallback.
5. In `ExportWorkspace`, keep WebM disabled with a status message while checking; cancel each effect generation on selection/project/session change and refuse stale completions.
6. Re-run both focused unit suites and verify existing injected-support tests remain compatible.

### Task 3: Close configuration-failure resources

**Files:**
- Modify: `packages/studio/test/preview-export.test.ts`
- Modify: `packages/studio/src/export/preview-export.ts`

1. Add a failing default-dependency test whose `VideoEncoder.configure()` throws synchronously and assert construction/close parity, no frame, no blob, and successful retry.
2. Run the focused test and confirm the reviewed implementation leaves the constructed encoder open.
3. Wrap `configure()` in the encoder-session factory with `try/catch`, safely close the constructed encoder, and rethrow for existing normalized error handling.
4. Re-run the focused tests and require one close per constructed encoder on every failure path.

### Task 4: Prove real Chromium cancellation and capability races

**Files:**
- Modify: `e2e/export.spec.ts`

1. Extend native WebCodecs instrumentation with encode-call count, maximum `encodeQueueSize`, support-check calls, configure attempts, and one-shot configure failure.
2. Add a long-export test that schedules cancellation from a real timer task after encoding begins, then requires cancellation before all source frames are encoded, no download, encoder closure, queue maximum at or below the exported design limit, and a successful retry state.
3. Add Chromium cases for pending/unsupported/rejected VP8 preflight and an out-of-order stale preflight completion after changing resolution or frame rate.
4. Add a configure-fail-once case requiring construction/close parity, no first download, visible failure, and a retryable enabled action.
5. Run the focused Chromium cases first against the reviewed head to capture expected failures, then after implementation until they pass without retries.

### Task 5: Documentation and release gates

**Files:**
- Modify: `docs/export-and-release.md`
- Modify: `docs/plans/2026-08-27-pr10-backpressure-vp8-preflight-remediation.md`

1. Document the VP8 configuration preflight, queue limit, dequeue wait, bounded macrotask yield, and cancellation/ownership checks.
2. Run focused Vitest and Chromium tests, full default-concurrency Vitest, full Chromium, lint, typecheck, build, OpenSpec strict, boundary smoke, pack/install/typecheck/build smoke, license consistency, and `git diff --check`.
3. Record first-run failures, reruns, environment limitations, and existing warnings without suppressing them.
4. Review the final diff against TML-384, commit on the task-local branch, and push `HEAD` to `agent/frontend/tml-54-preview-export` without close intent.
5. Verify the reviewed commit is an ancestor and local HEAD, remote branch head, and PR #10 head are identical; report the PR URL, base, fixed head, queue evidence, long-cancel evidence, and complete gate results.
