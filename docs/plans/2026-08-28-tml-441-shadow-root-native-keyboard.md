# TML-441 ShadowRoot Native Keyboard Protection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Preserve native keyboard behavior for Studio controls inside an open ShadowRoot without regressing Studio instance routing or the historical single-instance document/body fallback.

**Architecture:** Resolve the original keyboard source from `event.composedPath()[0]` in the shared keyboard-scope module and classify native controls structurally, without cross-realm `instanceof HTMLElement`. Reuse that single predicate in export shortcut capture, main editor shortcuts, and camera drive, while leaving nearest-root ownership routing unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, jsdom, Playwright Chromium and system Edge, Vite.

---

### Task 1: Reproduce ShadowRoot native-control takeover and fallback gaps

**Files:**
- Modify: `packages/studio/test/studio-keyboard-shadow-root.test.tsx`

**Step 1: Add failing ShadowRoot behavior tests**

Mount `LumoraStudio` under a real `attachShadow({ mode: 'open' })`. Append and focus native `input`, `textarea`, `select`, `button`, and contenteditable controls inside the Studio root, then dispatch composed keyboard events. Assert Delete/Backspace do not call `deleteSelection`, W/A/S/D do not move the selected camera, and button Space/Enter remain uncancelled and open export through the native click path without toggling playback.

**Step 2: Add table-driven fallback behavior tests**

For both `root.ownerDocument` and `root.ownerDocument.body`, mount one Studio, select an object, dispatch a Delete event through the actual window listener, and assert the selected object is deleted. Exercise behavior rather than directly calling `isKeyboardEventForStudio`.

**Step 3: Verify RED**

Run: `npm test -w @lumora/studio -- studio-keyboard-shadow-root.test.tsx`

Expected: FAIL because window listeners see the retargeted ShadowRoot host through `event.target`, causing deletion, camera movement, and playback takeover; the new fallback table is absent at the fixed PR head.

### Task 2: Unify realm-safe keyboard source and native-control protection

**Files:**
- Modify: `packages/studio/src/components/studio-keyboard-scope.ts`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Modify: `packages/studio/src/components/editor/EditorViewport.tsx`

**Step 1: Add the shared source and predicate**

Implement `keyboardEventSource(event)` from `event.composedPath()[0]` and `preservesNativeKeyboardSemantics(event)` using structural DOM capabilities such as `closest`, not the current realm's `HTMLElement` constructor. Match input, textarea, select, button, and editable content (including descendants).

**Step 2: Replace all three local checks**

Use the shared predicate in export shortcut capture, the main Studio key handler, and camera-drive keydown before any editor action or `preventDefault`. Keep `isKeyboardEventForStudio` nearest-root routing and owner-document/body fallback intact.

**Step 3: Verify GREEN and regressions**

Run: `npm test -w @lumora/studio -- studio-keyboard-shadow-root.test.tsx keyboard-round8.test.tsx lumora-studio.test.tsx export-workspace.test.tsx camera-drive-routing.test.tsx`

Expected: PASS, including nearest-root, sibling/nested Studio, external host control, light DOM, and document/body fallback coverage.

### Task 3: Run delivery gates and prepare the review head

**Files:**
- Review only: all changed files

**Step 1: Run required automated gates**

Run focused keyboard tests, full `npm test`, full development Chromium `npm run e2e`, production system-Edge `npm run e2e:preview`, `npm run lint`, `npm run typecheck`, `npm run build`, `npx openspec validate --all --strict --no-interactive`, and `git diff --check`.

**Step 2: Review and publish only with authorized branch delivery**

Review the scoped diff, commit with a TML-441 message, and push `HEAD` to `origin/agent/frontend/tml-54-preview-export` without close intent when project-manager authorization is confirmed. Verify local HEAD, the remote branch, and `refs/pull/10/head` agree; verify the PR base is an ancestor and the worktree is clean.
