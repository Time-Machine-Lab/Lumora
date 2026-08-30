# Recording Camera Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Add explicit, adjustable recording controls where the keyboard moves the selected camera, a right-button mouse drag rotates it, taps produce deterministic small steps, held keys move smoothly, and the existing recorder captures both inputs without visible jumps.

**Architecture:** Keep control preferences in the lifetime of one `TimelineSession`, avoiding project-schema and localStorage changes while the product persistence scope remains undecided. Extend `CameraDrive` as the single motion integrator: it owns short-tap timing, smoothed held movement, mode-aware key admission, and smoothed mouse-look deltas. Expose the mode and numeric controls in the timeline transport before recording, and route right-button pointer input from the viewport into the same drive instance so keyboard translation and mouse rotation cannot trigger one another.

**Tech Stack:** React 19, TypeScript, Three.js, Vitest/Testing Library, Playwright, Vite.

---

### Task 1: Restore The Reviewed Input-Layer Baseline

**Files:**
- Modify only as required by the reviewed TML-566 patch: `packages/studio/src/components/LumoraStudio.tsx`
- Modify only as required by the reviewed TML-566 patch: `packages/studio/src/components/editor/EditorViewport.tsx`
- Modify only as required by the reviewed TML-566 patch: `packages/studio/src/components/editor/TimelinePanel.tsx`
- Create only as required by the reviewed TML-566 patch: `packages/studio/src/components/editor/RecordingShortcutSettings.tsx`
- Create only as required by the reviewed TML-566 patch: `packages/studio/src/components/editor/recording-shortcut.ts`
- Test: `packages/studio/test/recording-shortcut.test.ts`
- Test: `packages/studio/test/lumora-studio.test.tsx`

**Step 1: Recover the dependency**

Fetch PR #11 head `f7cdab0910629f22b9dd7ffe30f4d397e49c86b5`. If the remote remains unavailable, apply the locally cached first commit `db0af623c244f1cee343cbaae16349b6f6ef0c47` on top of `main@95b021519127838edd9600558463ecae3476168c`, then reproduce only the fixes documented in the final PASS review: shared export-isolation predicate, dynamic recording shortcut, complete reserved-key fixtures, modal focus handling, and native-key/modifier routing.

**Step 2: Verify the dependency behavior**

Run: `npm test -w @lumora/studio -- recording-shortcut.test.ts lumora-studio.test.tsx camera-drive-routing.test.tsx`

Expected: PASS with the TML-566 shortcut, export isolation, ShadowRoot/native-input, and modifier tests green.

**Step 3: Commit the temporary dependency recovery only if exact PR head remains unavailable**

Run: `git commit -m "chore(studio): restore reviewed recording shortcut baseline"`

Before delivery, replace this temporary commit by rebasing the TML-565 commits onto exact PR #11 head when the remote becomes reachable.

### Task 2: Specify Deterministic Tap And Held Movement

**Files:**
- Modify: `packages/studio/test/camera-drive.test.ts`
- Modify: `packages/studio/src/components/editor/camera-drive.ts`

**Step 1: Write failing tests**

Add separate tests proving:

```ts
const drive = new CameraDrive({ tapStep: 0.1, holdDelay: 0.12, speed: 2.5 });
drive.attach(camera);
drive.press('KeyW');
drive.update(0.05);
drive.release('KeyW');
expect(camera.position.z).toBeCloseTo(startZ - 0.1, 6);
```

```ts
drive.press('KeyW');
drive.update(0.06);
drive.update(0.06);
drive.update(0.2);
expect(camera.position.z).toBeLessThan(startZ - 0.1);
```

Also prove repeat keydown does not reset hold timing and opposite taps cancel predictably.

**Step 2: Run the tests and verify RED**

Run: `npm test -w @lumora/studio -- camera-drive.test.ts`

Expected: FAIL because `tapStep`/`holdDelay` and deterministic tap handling do not exist.

**Step 3: Implement the minimal integrator changes**

Extend `CameraDriveSettings` with bounded `tapStep` and `holdDelay`. Track each admitted movement key's elapsed duration. A release before the threshold applies exactly one local-axis step; a held key contributes to the smoothed continuous target only after the threshold. Repeated `press()` calls for the same code are idempotent.

**Step 4: Run the tests and verify GREEN**

Run: `npm test -w @lumora/studio -- camera-drive.test.ts`

Expected: PASS.

### Task 3: Specify Mode-Aware Mouse Look

**Files:**
- Modify: `packages/studio/test/camera-drive.test.ts`
- Modify: `packages/studio/src/components/editor/camera-drive.ts`

**Step 1: Write failing tests**

Add tests for the desired API:

```ts
drive.setSettings({ mode: 'keyboard-mouse', mouseSensitivity: 1 });
expect(drive.acceptsKey('ArrowLeft')).toBe(false);
expect(drive.acceptsKey('KeyW')).toBe(true);
drive.look(40, -20);
drive.update(1 / 60);
expect(camera.rotation.y).not.toBe(0);
expect(camera.rotation.x).not.toBe(0);
```

Prove `look()` is ignored in `keyboard-only` mode, large pointer deltas are clamped, and residual look decays smoothly instead of applying as one unbounded jump.

**Step 2: Run the tests and verify RED**

Run: `npm test -w @lumora/studio -- camera-drive.test.ts`

Expected: FAIL because modes, mouse sensitivity, key admission, and `look()` do not exist.

**Step 3: Implement minimal mode and look support**

Add:

```ts
export type CameraControlMode = 'keyboard-mouse' | 'keyboard-only';

export interface CameraDriveSettings {
  mode: CameraControlMode;
  speed: number;
  tapStep: number;
  holdDelay: number;
  rotateSpeed: number;
  mouseSensitivity: number;
  smoothing: number;
}
```

Keep arrow rotation in `keyboard-only`; in `keyboard-mouse`, admit translation/focal/modifier keys and consume mouse-look deltas through the same frame update. Clear held input and residual look when the mode changes.

**Step 4: Run the tests and verify GREEN**

Run: `npm test -w @lumora/studio -- camera-drive.test.ts`

Expected: PASS.

### Task 4: Add Session-Level Controls Before Recording

**Files:**
- Modify: `packages/studio/test/use-timeline-session.test.tsx`
- Modify: `packages/studio/test/timeline-panel.test.tsx`
- Modify: `packages/studio/src/hooks/use-timeline-session.ts`
- Modify: `packages/studio/src/components/editor/TimelinePanel.tsx`
- Modify: `packages/studio/src/lumora.css`

**Step 1: Write failing session tests**

Assert the default mode is `keyboard-mouse`; `setCameraControlSettings()` clamps speed, tap step, and sensitivity; settings survive project changes within the same mounted Studio session; and callers cannot inject `NaN` or out-of-range values.

**Step 2: Run the session tests and verify RED**

Run: `npm test -w @lumora/studio -- use-timeline-session.test.tsx`

Expected: FAIL because the state and setter do not exist.

**Step 3: Implement session state**

Add `cameraControls: CameraDriveSettings` to `TimelineSessionState` and `setCameraControlSettings(settings: Partial<CameraDriveSettings>): void` to `TimelineSession`. Keep it session-local and update it with a pure clamp/normalization helper.

**Step 4: Write failing UI tests**

Assert the timeline renders a two-option segmented mode control plus labelled range/number controls for continuous speed, tap step, and mouse sensitivity; changing each control updates session state; controls remain keyboard operable and expose stable test ids.

**Step 5: Run the panel tests and verify RED**

Run: `npm test -w @lumora/studio -- timeline-panel.test.tsx`

Expected: FAIL because the controls are absent.

**Step 6: Implement the control strip**

Place the mode segments and numeric controls in an unframed transport band adjacent to the record control. Use compact labels, bounded range/number inputs, visible current values, `aria-pressed` for the mode buttons, and responsive wrapping without nested cards.

**Step 7: Run focused tests and verify GREEN**

Run: `npm test -w @lumora/studio -- use-timeline-session.test.tsx timeline-panel.test.tsx`

Expected: PASS.

### Task 5: Route Right-Button Pointer Look Into The Drive

**Files:**
- Modify: `packages/studio/test/camera-drive-routing.test.tsx`
- Modify: `packages/studio/src/components/editor/EditorViewport.tsx`

**Step 1: Write failing routing tests**

Add tests proving right-button drag rotates only the selected camera in the owning Studio when mode is `keyboard-mouse`; the same drag does not translate; `KeyW` translates without rotating; right-button drag is ignored in `keyboard-only`; pointer cancel, focus loss, export workspace, and overwrite confirmation stop residual look; and pointer capture/context-menu suppression are scoped to an active camera-look gesture.

**Step 2: Run the routing tests and verify RED**

Run: `npm test -w @lumora/studio -- camera-drive-routing.test.tsx`

Expected: FAIL because viewport pointer events do not reach `CameraDrive.look()`.

**Step 3: Implement pointer routing**

Pass the viewport element ref into `useCameraDrive`. Register scoped pointerdown/move/up/cancel and contextmenu handlers. Admit only button 2 when the current mode is `keyboard-mouse`, a selected camera is drivable, and no export/overwrite/native-control guard blocks the gesture. Use pointer capture when available, release it on every terminal path, and feed `movementX/Y` into `CameraDrive.look()`.

**Step 4: Apply live settings in the frame loop**

Before each update, synchronize `sessionRef.current.state.cameraControls` into the drive. Use `drive.acceptsKey()` before `preventDefault()` so keyboard-only arrows and keyboard-mouse pointer look remain independent.

**Step 5: Run the routing tests and verify GREEN**

Run: `npm test -w @lumora/studio -- camera-drive-routing.test.tsx`

Expected: PASS.

### Task 6: Prove Recording Sampling And Browser Behavior

**Files:**
- Modify: `packages/studio/test/timeline-recorder.test.ts`
- Modify: `e2e/timeline.spec.ts`

**Step 1: Write failing acceptance tests**

Add a browser test that selects `keyboard-mouse`, sets non-default step/speed/sensitivity, starts recording, performs one short `W` tap, holds `D`, then right-drags the viewport. Stop recording and assert position and rotation tracks both exist, the tap delta is bounded around the selected step, late held-motion samples continue smoothly, and adjacent rotation samples have no outlier jump.

Add a second test selecting `keyboard-only`: arrow input rotates while pointer dragging is ignored.

**Step 2: Run Chromium and verify RED**

Run: `npx playwright test e2e/timeline.spec.ts --project=chromium -g "recording control"`

Expected: FAIL before integration is complete.

**Step 3: Complete only the integration needed for GREEN**

Keep the existing per-frame `TimelineRecorder` sampling contract. If the RED test exposes duplicate timestamps or non-finite samples, add the smallest recorder guard with a dedicated unit test before changing production code.

**Step 4: Run focused acceptance and verify GREEN**

Run: `npx playwright test e2e/timeline.spec.ts --project=chromium -g "recording control"`

Expected: PASS.

### Task 7: Regression, Visual Evidence, And Delivery

**Files:**
- Modify if needed: `docs/export-and-release.md`
- Attach through Multica: Edge/Windows screenshot or recording plus test record

**Step 1: Run focused and full gates**

Run:

```bash
npm test -w @lumora/studio -- camera-drive.test.ts camera-drive-routing.test.tsx timeline-recorder.test.ts use-timeline-session.test.tsx timeline-panel.test.tsx recording-shortcut.test.ts lumora-studio.test.tsx
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: all tests/typecheck/build pass; lint has no new errors or warnings.

**Step 2: Run browser regression**

Run the recording-control acceptance in Chromium and installed Edge 152 on Windows 11. Capture desktop and narrow viewport screenshots, inspect that controls do not overflow or overlap, and record exact browser/OS versions. Do not claim Safari/macOS coverage from Windows WebKit.

**Step 3: Rebase onto exact PR #11 head**

When GitHub becomes reachable, fetch `f7cdab0910629f22b9dd7ffe30f4d397e49c86b5`, transplant only TML-565 commits onto it, rerun focused gates, and ensure the resulting PR contains no reconstructed TML-566-only diff.

**Step 4: Commit and push**

Run: `git commit -m "feat(studio): add adjustable recording camera controls"`

Push the dedicated branch and open a PR titled `TML-565: add adjustable recording camera controls` with `Closes TML-565` in the body. Do not merge.

**Step 5: Deliver through the issue**

Post one concise Multica issue comment with the PR URL, commit SHA, files changed, exact gate results, Edge/Windows evidence attachment, design decisions, and residual browser boundary. Move TML-565 to `in_review`.
