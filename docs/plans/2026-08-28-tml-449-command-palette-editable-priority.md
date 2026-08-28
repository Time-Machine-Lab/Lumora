# TML-449 Command Palette Escape and Editable Priority Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Make a single Escape close the command palette without clearing Studio selection, and preserve editing semantics when a focused button is nested below a contenteditable ancestor.

**Architecture:** Keep Studio ownership routing based on the composed event path. Let the command palette consume Escape at its dialog boundary before the window-level Studio shortcut handler, and classify an active contenteditable ancestor before applying the ordinary-button Escape exception. Prove the behavior through component tests and real Chromium light-DOM/open-ShadowRoot endpoints, including selection, inspector, and rendered gizmo pixels.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, jsdom, Playwright Chromium, Vite.

---

### Task 1: Reproduce the two TML-449 regressions

**Files:**
- Modify: `packages/studio/test/lumora-studio.test.tsx`
- Modify: `packages/studio/test/studio-keyboard-shadow-root.test.tsx`

**Step 1: Add the command-palette Escape regression**

Select `sample-cube`, open the palette with Ctrl+K, focus a command button, dispatch one Escape, and assert the palette closes while `clearSelection()` is not called and the selection remains.

**Step 2: Add light-DOM contenteditable nested-button coverage**

Append a real contenteditable element with a nested button below the Studio root, focus the button, dispatch Escape, and assert the editor selection remains.

**Step 3: Add open-ShadowRoot contenteditable nested-button coverage**

Mount Studio below a real open ShadowRoot, append the same editable/button structure, dispatch a composed Escape event, and assert selection remains.

**Step 4: Expand the native-control matrix**

Add a real `option` below the matrix's `select`, while retaining endpoints for Delete/Backspace, Space, W/A/S/D, and ordinary button Escape.

**Step 5: Verify RED**

Run: `npm test -w @lumora/studio -- lumora-studio.test.tsx studio-keyboard-shadow-root.test.tsx`

Expected: FAIL because the palette window listener runs after Studio clears selection and because button classification precedes contenteditable ancestry.

### Task 2: Add real Chromium behavioral endpoints

**Files:**
- Modify: `e2e/editor.spec.ts`

**Step 1: Add a reusable gizmo pixel counter**

Count pure red and blue axis pixels in the real viewport canvas so tests assert the rendered transform gizmo endpoint directly.

**Step 2: Strengthen ordinary button Escape**

For light DOM and a real open ShadowRoot, center and select the cube, confirm gizmo pixels exist, focus a normal Studio button, press Escape, and assert selection, inspector, and gizmo pixels all clear.

**Step 3: Add contenteditable nested-button cases**

For light DOM and a real open ShadowRoot, append a contenteditable container with a focused nested button inside the Studio root, press Escape, and assert selection, inspector, and gizmo pixels remain.

**Step 4: Add command-palette Escape priority**

Select the cube, confirm gizmo pixels exist, open the palette, focus a real command button, press Escape once, and assert the palette closes while selection, inspector, and gizmo pixels remain.

**Step 5: Verify RED on the fixed review baseline**

Run the new title filters against development Chromium while HEAD is `346efd5b8200d991100baeeb042a1db5e3768f23`.

Expected: the two new regressions fail for their production reasons; ordinary button Escape remains green and now proves the gizmo endpoint.

### Task 3: Implement minimal Escape routing fixes

**Files:**
- Modify: `packages/studio/src/components/CommandPalette.tsx`
- Modify: `packages/studio/src/components/studio-keyboard-scope.ts`

**Step 1: Consume palette Escape at the dialog boundary**

Handle Escape from descendants before the window Studio listener, call `preventDefault()` and propagation isolation, then close the palette once. Remove the replaceable window listener.

**Step 2: Prioritize active contenteditable ancestry**

Evaluate the real composed-path source's nearest `[contenteditable]` ancestor before the ordinary button exception. Keep structural duck typing for cross-realm and ShadowRoot safety.

**Step 3: Verify GREEN**

Re-run the focused Vitest and Playwright commands and confirm all new regressions pass.

### Task 4: Run delivery gates and publish the fixed PR head

**Files:**
- Review only: all changed files

**Step 1: Run required gates**

Run focused keyboard tests, full `npm test`, full development Chromium `npm run e2e`, production system-Edge `npm run e2e:preview`, `npm run lint`, all workspace typechecks, production `npm run build`, strict OpenSpec validation, pack boundary/full pack gates when the changed boundary warrants them, license generation consistency, and `git diff --check`.

**Step 2: Review, commit, and push**

Review the scoped diff, commit with a TML-446/TML-449 remediation message, and push `HEAD` to `origin/agent/frontend/tml-54-preview-export` without close intent. Verify local HEAD, the remote branch, and `refs/pull/10/head` agree; verify the PR base is an ancestor and the worktree is clean.
