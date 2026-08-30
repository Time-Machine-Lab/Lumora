# TML-566 HOLD Remediation Plan

**Goal:** Bring PR #11 onto `origin/main@95b0215`, close the reserved-shortcut and settings accessibility gaps, and provide executable AC4/AC5 browser evidence.

**Architecture:** Preserve main's native keyboard and viewport routing while layering the recording shortcut policy at the Studio capture boundary. Keep browser-reserved combinations in one explicit policy table, but test required combinations from an independent fixture. Exercise persistence and unload behavior through the public UI and IndexedDB so the acceptance evidence detects real regressions.

**Tech Stack:** React, TypeScript, Vitest/Testing Library, Playwright, IndexedDB.

### Task 1: Synchronize with main

**Files:**
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Modify: `packages/studio/src/components/editor/EditorViewport.tsx`
- Modify: `packages/studio/test/lumora-studio.test.tsx`

1. Merge `origin/main@95b0215` into the PR branch.
2. Resolve the three expected conflicts while preserving `preservesNativeKeyboardSemantics`, recording shortcut routing, and modifier hard-stop behavior.
3. Run the existing Studio and camera routing tests before adding new behavior.

### Task 2: Reject high-risk browser and OS shortcuts

**Files:**
- Modify: `packages/studio/test/recording-shortcut.test.ts`
- Modify: `packages/studio/src/components/editor/recording-shortcut.ts`

1. Add an independent fixture covering `Ctrl+Shift+B`, `Ctrl+Shift+O`, `Alt+F`, `Cmd+D`, `Cmd+Shift+P`, and equivalent high-risk combinations.
2. Assert each fixture produces an explicit browser-reserved error, returns `false` from save, and never calls or mutates storage.
3. Run the focused test and confirm it fails.
4. Extend the explicit policy and rerun until green.

### Task 3: Restore settings Escape and focus semantics

**Files:**
- Modify: `packages/studio/test/lumora-studio.test.tsx`
- Modify: `packages/studio/src/components/editor/RecordingShortcutSettings.tsx`

1. Add a test that moves focus outside the popover, presses Escape, and expects the popover to close with focus restored to its trigger.
2. Confirm the test fails.
3. Add document-level Escape handling scoped to the open popover and reuse one close path for outside pointer and Escape.
4. Rerun focused tests.

### Task 4: Make AC4 persistence boundaries executable

**Files:**
- Modify: `e2e/recording-shortcut.spec.ts`

1. Add a project fingerprint helper for track IDs, target paths, and keyframe times/values.
2. Accept `beforeunload` during an active recording, reopen the project, and prove the uncommitted recording fingerprint was not persisted.
3. Save a recording, close cleanly, reopen the recent project, and assert the rendered/project fingerprint matches the persisted fingerprint.
4. Run the Chromium scenario before the cross-browser matrix.

### Task 5: Add and execute the supported-browser matrix

**Files:**
- Modify: `playwright.config.ts`
- Modify: `package.json`

1. Define Chromium, Firefox, and WebKit Playwright projects without forcing a Chromium channel onto other engines.
2. Install or inspect available browser binaries and record exact versions.
3. Run the recording shortcut E2E in Chromium, Edge, Firefox, and WebKit where available; capture exact failures and unverified boundaries otherwise.

### Task 6: Verify and update PR #11

1. Run `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, and `git diff --check`.
2. Commit and push the updated branch to the existing PR.
3. Add `TML-566` to PR #11 title/body through an authenticated GitHub surface.
4. Verify the new head and Multica PR association, then report the evidence and residual risks for re-review.
