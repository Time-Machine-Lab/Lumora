# PR #8 Review Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Close every blocking, serious, and general finding from the independent review of PR #8 while preserving the provider-neutral storyboard scope.

**Architecture:** Harden the Core task boundary so untrusted provider values cannot escape diagnostics or prevent terminal completion, and bind task cancellation to the immutable identity of each registered provider contribution. Keep Studio draft state recoverable and derive adoption from project shot identities, while making dialog routing, ARIA relationships, cost display, and layout instance/container aware.

**Tech Stack:** TypeScript, React 19, Zod, Vitest, Testing Library, Playwright, npm workspaces.

---

### Task 1: Provider diagnostics and terminal completion

**Files:**
- Modify: `packages/core/test/ai-storyboard.test.ts`
- Modify: `packages/core/src/ai/storyboard.ts`
- Modify: `packages/core/src/services.ts`

**Step 1: Write the failing tests**

Add regressions which return a credential-shaped invalid enum value, reject a value whose `code` getter throws, reject a Proxy whose descriptor trap throws, and throw an internal `AbortError` without aborting the host signal.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/ai-storyboard.test.ts`

Expected: credential text is exposed, hostile errors time out in `running`, and internal `AbortError` has a failed/cancelled contradiction.

**Step 3: Implement the minimal hardening**

Summarize Zod failures using only trusted path/code metadata. Read provider error fields only through guarded own data descriptors, cap and redact diagnostic text, and return a constant provider-error fallback if any normalization step fails. Treat cancellation as `cancelled` only when the task's host `AbortSignal` is aborted.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/ai-storyboard.test.ts`

Expected: all task outcomes settle and no credential-shaped value appears in the public error.

### Task 2: Provider contribution identity and disposal cancellation

**Files:**
- Modify: `packages/core/test/plugin-host.test.ts`
- Modify: `packages/core/src/contributions/contribution-registry.ts`
- Modify: `packages/core/src/host/plugin-host.ts`

**Step 1: Write the failing tests**

Add one test that disposes a provider contribution while a task is running and another that mutates the provider object's `id` during deactivation.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/plugin-host.test.ts`

Expected: the early-disposed task remains running and mutable identity remains visible.

**Step 3: Implement immutable registration identity**

Snapshot the provider id and registered contribution when building the registration plan. Add an `onAiProviderRemoved` registry option; invoke it from the exact registration token's idempotent disposal path and connect it to `cancelStoryboardTasksForProvider` in `PluginHost`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/plugin-host.test.ts`

Expected: removal cancels admitted tasks, changed ids never become discoverable, and disable reaches a clean terminal state.

### Task 3: Mock long-brief boundary

**Files:**
- Modify: `examples/mock-plugin/test/storyboard.test.ts`
- Modify: `examples/mock-plugin/src/index.tsx`

**Step 1: Write the failing test**

Generate 24 shots from a 4,000-character concept and 500-character visual style and assert success plus a maximum 4,000-character prompt.

**Step 2: Run test to verify it fails**

Run: `npx vitest run examples/mock-plugin/test/storyboard.test.ts`

Expected: the task ends as `schema_invalid`.

**Step 3: Budget prompt text**

Build the fixed per-shot suffix first and truncate the concept to the remaining prompt budget without changing the requested shot count or duration behavior.

**Step 4: Run test to verify it passes**

Run: `npx vitest run examples/mock-plugin/test/storyboard.test.ts`

Expected: the boundary task succeeds with 24 valid prompts.

### Task 4: Studio multi-instance accessibility and cost formatting

**Files:**
- Modify: `packages/studio/test/storyboard-workspace.test.tsx`
- Modify: `packages/studio/src/components/storyboard/StoryboardWorkspace.tsx`

**Step 1: Write the failing tests**

Mount two Studios, open both workspaces, and assert unique dialog/tab/panel ids plus unblocked key delivery in the second root. Add zero USD, sub-cent USD, and JPY cost expectations.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/studio/test/storyboard-workspace.test.tsx`

Expected: ids collide, the first capture listener blocks the second workspace, sub-cent USD renders as zero, and JPY uses two decimals.

**Step 3: Implement instance-aware behavior**

Use React `useId()` for dialog/tab/panel relationships. Route captured keyboard events only when the event target or active element belongs to the same `.lumora-studio` root. Format known costs with the currency's minor-unit precision and show a less-than threshold for positive values below one minor unit.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/studio/test/storyboard-workspace.test.tsx`

Expected: both dialogs remain operable and all cost states are unambiguous.

### Task 5: Draft recovery, adoption truth, and shot edits

**Files:**
- Modify: `packages/studio/test/storyboard-workspace.test.tsx`
- Modify: `packages/studio/src/components/storyboard/StoryboardWorkspace.tsx`

**Step 1: Write the failing tests**

Cover failed regeneration retaining an edited last-success draft, stale brief/model disabling adoption, deletion/undo toggling adoption based on project shots, unchanged blur preserving revision/history, and clearing a non-AI prompt by deleting the optional field.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/studio/test/storyboard-workspace.test.tsx`

Expected: the old draft disappears, adoption stays latched after deletion, and blur/empty optional prompt creates invalid history or fails.

**Step 3: Implement recoverable state**

Keep the last successful draft until a new success arrives, store draft-shot to project-shot ids returned by the editor, and derive accepted state from current `project.shots`. Compare the current request with `draft.brief/provider/model` to mark stale drafts and disable adoption. Normalize edit candidates before submission, skip unchanged values, remove a blank optional prompt for non-AI shots, and preserve the required non-empty AI prompt rule.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/studio/test/storyboard-workspace.test.tsx`

Expected: recovery and project synchronization remain correct across delete, undo, retry, and blur.

### Task 6: Embedded container responsiveness

**Files:**
- Modify: `packages/studio/src/lumora.css`
- Modify: `e2e/storyboard.spec.ts`

**Step 1: Write the failing browser test**

At a 1280px viewport, constrain the embedded Studio to 600px and assert the storyboard has no horizontal overflow and exposes both brief and draft regions.

**Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/storyboard.spec.ts`

Expected: the 690px intrinsic grid is clipped inside the 600px Studio.

**Step 3: Implement container-aware layout**

Make the Studio stage an inline-size query container and move storyboard 900px/560px adaptations from viewport media queries to container queries.

**Step 4: Run test to verify it passes**

Run: `npx playwright test e2e/storyboard.spec.ts`

Expected: wide-page/narrow-embed and mobile cases both remain usable without horizontal overflow.

### Task 7: Full verification and delivery

**Files:**
- Verify all files changed from `f21bb8b54a5048924de224088c1ce9b20eb75568`

**Step 1: Run repository gates**

Run: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `npm run e2e`, `npm run smoke:pack`, `npm run smoke:pack:boundary`, `git diff --check f21bb8b54a5048924de224088c1ce9b20eb75568..HEAD`, and the repository OpenSpec strict validation command.

**Step 2: Scan for credentials and review the diff**

Search source/build output for credential-shaped sentinels, inspect the complete branch diff, and run the requested independent code-review workflow.

**Step 3: Commit and push the authorized PR branch**

Create one scoped remediation commit, push `HEAD` to `agent/frontend/tml-55-ai-storyboard`, and verify the local, remote branch, and `refs/pull/8/head` SHAs match.

**Step 4: Hand off for independent re-review**

Report PR URL, base/head, changed scope, gate counts, and any residual limits. Leave TML-239 in `in_review`; do not approve or merge PR #8.
