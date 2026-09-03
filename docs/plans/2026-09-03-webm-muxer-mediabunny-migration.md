# Deprecated WebM Muxer to Mediabunny Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Replace the deprecated `webm-muxer` runtime dependency with maintained Mediabunny while preserving Lumora's explicit WebM timestamps, terminal-frame duration boundary, cancellation, backpressure, cleanup, and browser compatibility contracts.

**Architecture:** Keep `recordPreviewWebm` and its dependency-injected `PreviewEncoderSession` boundary stable for existing workspace behavior and tests. Replace only the default container path with Mediabunny's `Output` + `WebMOutputFormat` + `BufferTarget` + `EncodedVideoPacketSource`, converting each WebCodecs `EncodedVideoChunk` to an `EncodedPacket` while retaining microsecond timestamps and the existing operation guards, queue limits, and finalization timeout. Update dependency, lockfile, generated notices, release documentation, and focused regression coverage.

**Tech Stack:** React 19, TypeScript, WebCodecs, Mediabunny 1.55.x (MPL-2.0), Vitest + Testing Library, Playwright Chromium, FFmpeg `ffprobe`.

**Dependency comparison:** `webm-muxer@5.1.4` is MIT, WebM-only, deprecated, and 147,682 bytes unpacked; `mediabunny@1.55.6` is MPL-2.0, maintained and tree-shakable, and 10,431,508 bytes unpacked. Both rely on browser WebCodecs for encoding; Mediabunny adds an asynchronous packet writer, so packet adds are serialized and awaited before finalization.

---

### Task 1: Capture the migration contract in focused tests

**Files:**
- Modify: `packages/studio/test/preview-export.test.ts`
- Modify: `packages/studio/src/export/preview-export.ts`

**Steps:**
1. Add a failing default-dependency test that stubs Mediabunny output/source classes and requires one source sample per explicit timestamp, including the terminal sample at `N / fps`.
2. Add assertions that source samples use second-based timestamp/duration values equivalent to the existing microsecond frame contract, with a zero-duration terminal packet at `N / fps`, and that finalization occurs only after encoder flush.
3. Add cancellation/finalization failure coverage that requires `Output.cancel()` or source cleanup and no returned blob; retain existing injected-session tests for queue, timing, retry, and encoder cleanup behavior.
4. Run `npx vitest run packages/studio/test/preview-export.test.ts` and confirm the new default-path tests fail before implementation.

### Task 2: Implement Mediabunny-backed encoding

**Files:**
- Modify: `packages/studio/src/export/preview-export.ts`

**Steps:**
1. Replace the `webm-muxer` import and default session construction with Mediabunny `Output`, `WebMOutputFormat`, `BufferTarget`, `EncodedVideoPacketSource`, and `EncodedPacket`.
2. Map Lumora MIME/codec selection to Mediabunny `vp8`/`vp9`, configure bitrate and frame rate metadata, and start the output before accepting samples; bundle Mediabunny into Studio so its pinned ambient WebCodecs types are not installed into consuming applications.
3. Keep `encodeFrame` on the existing WebCodecs path, converting each output chunk with `EncodedPacket.fromEncodedChunk` and serializing `EncodedVideoPacketSource.add` calls so Mediabunny writer backpressure is honored.
4. Implement `flush` by awaiting WebCodecs flush, pending packet writes, and `Output.finalize()`, then returning a `Blob` from `BufferTarget.buffer`; implement `close` with idempotent `Output.cancel()`/encoder cleanup for all failure and cancellation paths.
5. Preserve observable queue-size/dequeue behavior at the `PreviewEncoderSession` boundary or adjust the boundary to await Mediabunny's add promises without weakening the existing max-four-frame and abort checks.
6. Run the focused tests until green, then refactor only after the behavior is covered.

### Task 3: Update dependency, lockfile, and license inventory

**Files:**
- Modify: `packages/studio/package.json`
- Modify: `package-lock.json`
- Modify: `docs/THIRD_PARTY_NOTICES.md`

**Steps:**
1. Replace `webm-muxer` with a pinned compatible `mediabunny` range in `packages/studio/package.json`.
2. Regenerate the lockfile with the repository's npm mirror/cache configuration and verify no `webm-muxer` package remains.
3. Run `npm run licenses:generate` and review the generated Mediabunny MPL-2.0 entry and any transitive inventory changes; ensure no `UNKNOWN` license appears.
4. Run `git diff --check`.

### Task 4: Verify real Chromium artifacts and browser support

**Files:**
- Modify: `e2e/export.spec.ts` (only if current assertions need Mediabunny-specific timing/cleanup evidence)

**Steps:**
1. Run the existing Chromium preview export cases and inspect downloaded WebM files with `ffprobe` for packet count, monotonic PTS, terminal PTS at `N / fps`, container duration, and visual order.
2. Add or update a regression assertion for cancellation/backpressure to ensure no stale download and encoder resources are released.
3. Run `npm run e2e:preview` when Edge and `ffprobe` prerequisites are available; record any environment limitation without weakening assertions.

### Task 5: Documentation and release gates

**Files:**
- Modify: `docs/export-and-release.md`
- Modify: `docs/plans/2026-08-27-pr10-terminal-frame-focus-race-remediation.md`

**Steps:**
1. Document Mediabunny's role, MPL-2.0 obligation, explicit timestamp conversion, terminal-frame encoding, backpressure, and finalization/cancel barrier.
2. Remove stale references that describe `webm-muxer` as the active implementation while preserving historical plan context where useful.
3. Run `npm run test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run smoke:pack:boundary`, `npm run smoke:pack`, `npm run licenses:generate`, and `git diff --check`.
4. Review the final diff for unrelated changes, then commit and open a PR whose title or body includes `TML-383`.
