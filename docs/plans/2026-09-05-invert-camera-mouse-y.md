# Invert Camera Mouse Y Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Add a session-scoped, default-off mouse vertical inversion setting for keyboard-and-mouse camera control without affecting horizontal look or keyboard rotation.

**Architecture:** Extend the existing normalized `CameraDriveSettings` object so the new boolean follows the same lifetime as speed, step, and sensitivity. Apply the sign when pointer Y input is queued, cancel queued look when the value changes, and make the viewport release an active right-button gesture at that boundary. Expose the value as an accessible checkbox in the existing camera-control strip.

**Tech Stack:** React 19, TypeScript, Three.js, Vitest, Testing Library, Playwright.

---

### Task 1: Core setting and input behavior

**Files:**
- Modify: `packages/studio/test/camera-drive.test.ts`
- Modify: `packages/studio/src/components/editor/camera-drive.ts`

**Step 1: Write the failing tests**

Add tests that construct normal and inverted drives, send the same `look(40, 20)` input, and assert equal yaw with opposite pitch. Add a boundary test that queues pointer look, changes only `invertMouseY`, and verifies no queued rotation is applied while an already-held keyboard movement key remains active.

**Step 2: Run tests to verify they fail**

Run: `npm test -w @lumora/studio -- camera-drive.test.ts`

Expected: FAIL because `CameraDriveSettings` has no `invertMouseY` field and inversion is not applied.

**Step 3: Write the minimal implementation**

Add `invertMouseY: boolean`, default it to `false`, normalize only explicit booleans, and queue vertical look as:

```ts
const verticalDelta = this.settings.invertMouseY ? -deltaY : deltaY;
this.lookDelta.y = THREE.MathUtils.clamp(
  this.lookDelta.y + verticalDelta,
  -MAX_LOOK_DELTA,
  MAX_LOOK_DELTA,
);
```

When `setSettings` changes inversion without changing mode, call `cancelLook()` rather than clearing keyboard input.

**Step 4: Run tests to verify they pass**

Run: `npm test -w @lumora/studio -- camera-drive.test.ts`

Expected: PASS.

### Task 2: Session state, UI, and gesture boundary

**Files:**
- Modify: `packages/studio/test/use-timeline-session.test.tsx`
- Modify: `packages/studio/test/timeline-panel.test.tsx`
- Modify: `packages/studio/test/camera-drive-routing.test.tsx`
- Modify: `packages/studio/src/components/editor/TimelinePanel.tsx`
- Modify: `packages/studio/src/components/editor/EditorViewport.tsx`
- Modify: `packages/studio/src/lumora.css`

**Step 1: Write the failing tests**

Assert the session default is `false`, explicit `true` survives a project switch, explicit `false` is accepted, and a remounted session returns to the shared default. Assert the panel checkbox exposes its checked/unchecked state and calls `setCameraControlSettings({ invertMouseY: ... })`. Add a viewport routing test that changes inversion during an active right-button gesture and proves stale pointer movement is ignored until a fresh pointerdown.

**Step 2: Run tests to verify they fail**

Run: `npm test -w @lumora/studio -- use-timeline-session.test.tsx timeline-panel.test.tsx camera-drive-routing.test.tsx`

Expected: FAIL because the checkbox and inversion gesture boundary do not exist.

**Step 3: Write the minimal implementation**

Render a checkbox labeled `垂直反转` and pass its checked value to the session setter. Keep it configurable in keyboard-only mode so users can prepare the setting before switching modes; the value only affects keyboard-mouse pointer look. In the viewport loop compare the previous and current `invertMouseY`; on change call `drive.cancelLook()` and `endLookGesture()` so the next drag requires a new pointerdown. Add compact checkbox sizing that participates in the existing responsive flex layout.

**Step 4: Run tests to verify they pass**

Run: `npm test -w @lumora/studio -- use-timeline-session.test.tsx timeline-panel.test.tsx camera-drive-routing.test.tsx`

Expected: PASS.

### Task 3: Browser regression and delivery verification

**Files:**
- Modify: `e2e/timeline.spec.ts`

**Step 1: Write the failing browser regression**

Exercise normal drag, inverted drag, mid-gesture toggle, fresh drag, explicit disable, and page reload. Assert pitch direction reverses, heading/keyboard behavior remains unchanged, stale movement after the toggle does not mutate the camera, and reload restores the default-off state.

**Step 2: Run the browser test to verify it fails**

Run: `npx playwright test e2e/timeline.spec.ts --project=chromium --grep "vertical inversion"`

Expected: FAIL because the new control is absent.

**Step 3: Complete the regression and visual checks**

Run focused tests, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and the focused Chromium Playwright test. Capture desktop and mobile screenshots and inspect the control for clear state, overflow, and overlap.

**Step 4: Deliver through GitHub**

Review the scoped diff, commit the implementation and tests, push the task branch, create one draft PR targeting `main` with `task_id: TML-813` and `run_id: 1443ad39-7c9e-4c7a-b3a2-1f8bc5959f24`, then read the PR title/body back for metadata verification.
