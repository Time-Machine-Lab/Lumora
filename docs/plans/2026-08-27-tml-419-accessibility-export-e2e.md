# TML-419 Accessibility And Production Export E2E Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Close TML-416 findings 3 through 7 with keyboard-accessible host logs, deterministic export focus and keyboard boundaries, bounded live announcements, and an explicit production Edge preview gate.

**Architecture:** Keep visual export progress on the existing per-frame state while moving assistive announcements to a separate bucketed live-region state. Reuse one activation-key propagation helper at both the toolbar entry and export workspace boundary, and retain each operation initiator through every terminal state. Keep the camera pose hook development-only; production tests will assert user-visible inspector values and run through a dedicated preview configuration.

**Tech Stack:** React 19, TypeScript, Vitest/Testing Library, Playwright, Vite, axe-core.

---

### Task 1: Make the host event log keyboard accessible

**Files:**
- Modify: `examples/embedded-host/src/App.tsx`
- Modify: `examples/embedded-host/src/app.css`
- Create: `e2e/accessibility.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write the failing tests**

Install `@axe-core/playwright` as a root development dependency. Add a Playwright test that reverse-tabs into `data-testid="host-event-log"`, verifies its accessible name and visible focus outline, scrolls it with `PageDown`, and runs full-document axe at 1440x900, 1280x800, and 375x667 with zero violations and zero incomplete results.

**Step 2: Run the tests to verify RED**

Run: `npx playwright test e2e/accessibility.spec.ts`

Expected: FAIL because the scrollable `aside` is not focusable and axe reports `scrollable-region-focusable`.

**Step 3: Implement the minimum semantic fix**

Give the heading a stable id, add `tabIndex={0}`, `aria-labelledby`, and `data-testid` to the `aside`, then add a `:focus-visible` outline using the host accent color.

**Step 4: Run the test to verify GREEN**

Run: `npx playwright test e2e/accessibility.spec.ts`

Expected: PASS at all three viewports, including keyboard scrolling.

### Task 2: Bound export keyboard events and restore terminal focus

**Files:**
- Modify: `packages/studio/src/components/studio-keyboard-scope.ts`
- Modify: `packages/studio/src/components/Toolbar.tsx`
- Modify: `packages/studio/src/components/export/ExportWorkspace.tsx`
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `e2e/export.spec.ts`

**Step 1: Write the failing tests**

Add unit and browser assertions that Enter and Space from manifest, PNG, WebM, cancel, and retry buttons never reach a later host `window` listener. Extend browser focus coverage so WebM success, cancellation, failure, and successful retry all focus the initiating WebM button.

**Step 2: Run the tests to verify RED**

Run: `npm test -w @lumora/studio -- export-workspace.test.tsx`

Run: `npx playwright test e2e/export.spec.ts --grep "host activation|restores focus"`

Expected: FAIL because export controls do not stop activation-key propagation and success does not queue focus restoration.

**Step 3: Implement shared propagation and terminal focus**

Export a helper that stops propagation for `Enter` and Space, reuse it on the toolbar trigger, and apply it at the export workspace boundary. Queue the operation initiator for `success`, `cancelled`, and `error`, and run the existing connected/enabled fallback focus logic for all terminal states.

**Step 4: Run the tests to verify GREEN**

Repeat the focused Vitest and Playwright commands; expect all assertions to pass.

### Task 3: Separate visual progress from live announcements

**Files:**
- Modify: `packages/studio/src/components/export/ExportWorkspace.tsx`
- Modify: `packages/studio/src/lumora.css`
- Modify: `packages/studio/test/export-workspace.test.tsx`
- Modify: `e2e/export.spec.ts`

**Step 1: Write the failing test**

Observe a dedicated `data-testid="export-live-status"` while a short export renders many frames. Assert that visual progress still reaches 100, running announcements are limited to fixed milestone buckets rather than frames, and each success/cancel/error terminal transition is exposed immediately once.

**Step 2: Run the test to verify RED**

Run: `npm test -w @lumora/studio -- export-workspace.test.tsx`

Expected: FAIL because the current semantic status changes for every progress callback and has no separate live contract.

**Step 3: Implement bucketed announcements**

Keep `progress` and the visible running message continuous. Add a visually hidden live status that announces start, 25/50/75 percent milestones, and terminal states; reset its bucket per operation and never announce frame-level shot changes.

**Step 4: Run the tests to verify GREEN**

Repeat the focused Vitest command and the relevant export Playwright test; expect bounded announcements and all terminal states to pass.

### Task 4: Add an explicit production Edge preview project

**Files:**
- Create: `playwright.preview.config.ts`
- Modify: `package.json`
- Modify: `e2e/export.spec.ts`

**Step 1: Write the failing production contract**

Change the export shortcut isolation test to read the selected camera's visible inspector position fields instead of `camera-pose-readout`. Add an `edge-preview` Playwright project with `channel: 'msedge'` and a Vite build-plus-preview web server.

**Step 2: Run the production test to verify RED**

Run: `npm run e2e:preview -- e2e/export.spec.ts --grep "isolates editor shortcuts"`

Expected before the test-contract change: FAIL because the DEV-only pose readout is absent from the production bundle.

**Step 3: Complete the production-safe assertion**

Read and compare the user-visible X/Y/Z inspector inputs before and after idle/encoding shortcut attempts. Do not mount the hidden pose readout in production.

**Step 4: Run the project to verify GREEN**

Run: `npm run e2e:preview`

Expected: the full `edge-preview` project passes against the production bundle.

### Task 5: Run release gates and deliver the fixed head

**Files:**
- Verify all changed files

**Step 1: Run focused and full verification**

Run related Vitest, Chromium E2E, Edge preview E2E, page-level axe, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run smoke:pack`, `npm run licenses:generate` plus a clean-diff check, and `git diff --check`.

**Step 2: Review the diff**

Confirm no privacy, determinism, cancellation, retry, resource cleanup, or layout behavior regressed. Run the repository's code-review workflow before delivery.

**Step 3: Commit and push**

Commit with a TML-419 message and push the task head to `origin/agent/frontend/tml-54-preview-export` without close intent.

**Step 4: Confirm immutable handoff**

Verify local `HEAD`, `refs/heads/agent/frontend/tml-54-preview-export`, and `refs/pull/10/head` resolve to the same new commit, then report PR URL, base, head, checks, warnings, and clean worktree.
