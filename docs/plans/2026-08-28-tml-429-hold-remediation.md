# TML-429 HOLD Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Replace the false-positive production shortcut evidence and close the host keyboard, repeated live announcement, first-success focus, and production prerequisite gaps reported against PR #10 head `e028926`.

**Architecture:** Expose the selected camera's live THREE-node position through the existing visible inspector using a small external store shared by the viewport and properties panel, so production tests observe real drive movement without persisting transient input. Restrict the single-Studio fallback to unowned `document`/`body` events, model live announcements as sequenced events that replace a child inside the live region, and preflight system Edge plus `ffprobe` before starting production preview tests.

**Tech Stack:** React 19, TypeScript, Three.js, Vitest/Testing Library, Playwright Chromium and system Edge, Vite, Node.js.

---

### Task 1: Make the production shortcut observation sensitive to live camera drive

**Files:**
- Create: `packages/studio/src/components/editor/live-transform-store.ts`
- Modify: `packages/studio/src/components/editor/EditorViewport.tsx`
- Modify: `packages/studio/src/components/editor/PropertiesPanel.tsx`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Create: `packages/studio/test/live-transform-store.test.ts`
- Modify: `e2e/export.spec.ts`

**Step 1: Write the failing tests**

Add a store unit test for stable snapshots and an E2E control assertion that holds `W` before opening export and requires the visible inspector position to change. Keep separate idle-workspace and active-encoding assertions that require the same position to stay fixed.

**Step 2: Run test to verify RED**

Run: `npm test -w @lumora/studio -- live-transform-store.test.ts`

Run: `npx playwright test e2e/export.spec.ts --grep "proves live camera drive"`

Expected: FAIL because no live-node inspector store exists and the current inspector reads static `object.transform`.

**Step 3: Implement the minimum production contract**

Create a shallow-equality external store keyed by object id. Publish the selected camera node's position from an R3F `useFrame` bridge, subscribe only the properties panel with `useSyncExternalStore`, and use the live position for the existing visible inspector axis inputs when the selected object matches.

**Step 4: Run test to verify GREEN**

Repeat both focused commands. The pre-export control must move by a measurable amount; export-idle and encoding samples must remain unchanged.

### Task 2: Keep host focusable controls outside Studio keyboard ownership

**Files:**
- Modify: `packages/studio/src/components/studio-keyboard-scope.ts`
- Modify: `packages/studio/test/keyboard-round8.test.tsx`
- Modify: `e2e/accessibility.spec.ts`

**Step 1: Write the failing tests**

Add a unit assertion that a single Studio rejects keyboard events from a focusable host control while retaining `document.body` fallback. Extend the host log browser test to reset scroll, press Space on the focused log, require scrolling, and require the timeline play label to stay unchanged.

**Step 2: Run test to verify RED**

Run: `npm test -w @lumora/studio -- keyboard-round8.test.tsx`

Run: `npx playwright test e2e/accessibility.spec.ts --grep "host event log"`

Expected: FAIL because the one-Studio fallback currently claims every event target outside the root.

**Step 3: Implement the minimum routing fix**

Allow the fallback only when the event target is `document`, `document.body`, or another non-Node global target. Preserve events originating inside the owning root and the existing multiple-Studio behavior.

**Step 4: Run test to verify GREEN**

Repeat both focused commands and retain the existing PageDown and multi-instance assertions.

### Task 3: Emit a DOM/live-region change for every repeated terminal announcement

**Files:**
- Modify: `packages/studio/src/components/export/ExportWorkspace.tsx`
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `e2e/export.spec.ts`

**Step 1: Write the failing tests**

Record raw added live-announcement nodes without text de-duplication. Add independent assertions for two identical manifest, PNG, and WebM successes and for two identical invalid-camera preflight errors.

**Step 2: Run test to verify RED**

Run: `npm test -w @lumora/studio -- export-workspace.test.tsx`

Run: `npx playwright test e2e/export.spec.ts --grep "repeated identical"`

Expected: FAIL because React preserves the unchanged text node for identical consecutive `{kind,message}` values.

**Step 3: Implement sequenced announcement events**

Store `{id,status}` for each announcement, increment the id for every published event, and key a child node inside the polite/assertive region by that id. Keep visual status and bounded WebM milestones unchanged.

**Step 4: Run test to verify GREEN**

Repeat the focused unit and Chromium commands. Each operation must produce two raw child insertions with the expected text.

### Task 4: Prove clean first-attempt WebM success focus

**Files:**
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `e2e/export.spec.ts`

**Step 1: Add the missing independent assertion**

In a clean workspace, focus/click the WebM initiator once, await the first successful download and terminal status, and assert focus returns to that same enabled button. Keep cancellation, failure, and failure-then-retry coverage intact.

**Step 2: Run the focused tests**

Run: `npm test -w @lumora/studio -- export-workspace.test.tsx`

Run: `npx playwright test e2e/export.spec.ts --grep "first WebM success"`

Expected after the existing production behavior is exercised: PASS with direct first-attempt evidence.

### Task 5: Add production prerequisites and run release gates

**Files:**
- Create: `scripts/check-preview-prerequisites.mjs`
- Modify: `package.json`
- Modify: `docs/export-and-release.md`

**Step 1: Add prerequisite checks**

Check for a runnable system Edge executable on Windows/macOS/Linux and a runnable `ffprobe`. Exit before Playwright with actionable installation/path guidance when either is missing. Run the check from `npm run e2e:preview`.

**Step 2: Verify prerequisites and full gates**

Run: `node scripts/check-preview-prerequisites.mjs`

Run focused unit tests, full `npm test`, `npm run e2e`, `npm run e2e:preview`, the three viewport axe spec, `npm run lint`, `npm run typecheck`, `npm run build`, `npx openspec validate --all --strict --no-interactive`, `npm run smoke:pack:boundary`, `npm run smoke:pack`, `npm run licenses:generate`, a NOTICE consistency check, and `git diff --check`.

**Step 3: Review, commit, push, and verify the fixed head**

Review the scoped diff, commit with a TML-429 message, and push `HEAD` to `origin/agent/frontend/tml-54-preview-export` without close intent. Verify local HEAD, the remote branch, and `refs/pull/10/head` agree; verify the PR base is an ancestor and the worktree is clean.
