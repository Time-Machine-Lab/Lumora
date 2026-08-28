# TML-446 Button Escape and ShadowRoot Keyboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Restore button-originated Escape clearing while preserving native control editing, button activation, Studio ownership routing, and real viewport focus for camera recording.

**Architecture:** Keep nearest-root ownership in `studio-keyboard-scope.ts`, but classify keyboard protection from both the composed-path control type and the pressed key. Editing controls retain all native semantics; button-like controls retain every key except unconsumed Escape, which reaches the existing Studio clear-selection path. Prove the contract at component and real-browser boundaries, including an open ShadowRoot and native keyboard-generated clicks.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, jsdom, Playwright Chromium and system Edge, Vite.

---

### Task 1: Reproduce button Escape and control-matrix regressions

**Files:**
- Modify: `packages/studio/test/lumora-studio.test.tsx`
- Modify: `packages/studio/test/studio-keyboard-shadow-root.test.tsx`

**Step 1: Add a failing light-DOM button Escape test**

Select `sample-cube`, focus the timeline play button, dispatch Escape, and assert `clearSelection()` runs and the editor selection becomes empty.

**Step 2: Add a failing open-ShadowRoot button Escape test**

Mount the Studio below `attachShadow({ mode: 'open' })`, select `sample-cube`, focus a real Studio button, dispatch a composed Escape event, and assert the same selection endpoint.

**Step 3: Strengthen native-control endpoints**

For input, textarea, select, button, and a contenteditable descendant, assert Delete/Backspace preserve selection, W/A/S/D leave the camera pose unchanged, and Space leaves timeline playback unchanged. Keep Ctrl+K, nearest-root, nested/sibling, external-host, and owner-document/body cases intact.

**Step 4: Verify RED**

Run: `npm test -w @lumora/studio -- lumora-studio.test.tsx studio-keyboard-shadow-root.test.tsx camera-drive-routing.test.tsx keyboard-round8.test.tsx`

Expected: FAIL because the current native-control predicate returns early for button Escape.

### Task 2: Reproduce real Chromium ShadowRoot behavior

**Files:**
- Modify: `e2e/editor.spec.ts`
- Modify: `e2e/export.spec.ts`
- Modify: `e2e/timeline.spec.ts`

**Step 1: Add light-DOM and real open-ShadowRoot button Escape cases**

Focus a Studio button after selecting an object, press Escape, and assert the selected row and inspector selection disappear. Move the live React root beneath a real open ShadowRoot for the second case so composed-path retargeting is exercised by Chromium.

**Step 2: Add real ShadowRoot native activation cases**

For Space and Enter, focus the export button and call only `press()` on that button. Count native click events, assert exactly one export opening, and assert timeline playback does not change.

**Step 3: Replace synthetic timeline focus evidence**

After overwrite confirmation, click the viewport at a non-selecting coordinate with Control held and assert the viewport is focused before driving. Remove the direct `.focus()` call.

**Step 4: Verify RED**

Run the new Playwright title filters against development Chromium.

Expected: button Escape cases FAIL on `d3caa7f`; native activation and pointer-focus cases establish independent browser evidence.

### Task 3: Implement key-semantic native control routing

**Files:**
- Modify: `packages/studio/src/components/studio-keyboard-scope.ts`

**Step 1: Split editable and button-like control classification**

Keep input, textarea, select, option, and active contenteditable descendants fully protected. For button-like controls, return false only for Escape so unconsumed Escape reaches `clearSelection()`; preserve Space/Enter and non-Escape keys such as Delete, Backspace, and W/A/S/D.

**Step 2: Verify GREEN**

Run the focused Vitest and Playwright commands from Tasks 1 and 2 and confirm all new regressions pass.

### Task 4: Run delivery gates and publish the fixed PR head

**Files:**
- Review only: all changed files

**Step 1: Run required gates**

Run focused keyboard tests, full `npm test`, full development Chromium `npm run e2e`, production system-Edge `npm run e2e:preview`, `npm run lint`, the six-workspace `npm run typecheck`, `npm run build`, `npx openspec validate --all --strict --no-interactive`, `npm run smoke:pack:boundary`, `npm run smoke:pack`, `npm run licenses:generate`, NOTICE consistency, and `git diff --check`.

**Step 2: Review, commit, and push**

Review the scoped diff, commit with a TML-446 message, and push `HEAD` to `origin/agent/frontend/tml-54-preview-export` without close intent. Verify local HEAD, the remote branch, and `refs/pull/10/head` agree; verify the PR base is an ancestor and the worktree is clean.
