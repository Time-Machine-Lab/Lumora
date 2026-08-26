# PR #8 Sixth Review Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Make plugin diagnostics stable summary DTOs and make every public AI storyboard task/provider snapshot recursively readonly in TypeScript and frozen at runtime.

**Architecture:** Keep mutable lifecycle and task records private to Core. At each public boundary, project internal state into a host-owned DTO, clone it, and recursively freeze the returned object graph. Reuse one `PluginDiagnostic` summary type for plugin events and `PluginInfo`, and reuse one task snapshot helper for submit, get, and wait.

**Tech Stack:** TypeScript, Vitest, npm workspaces, React 19 consumers.

---

### Task 1: Stable plugin diagnostic DTO

**Files:**
- Modify: `packages/core/test/plugin-host.test.ts`
- Modify: `packages/core/src/events/event-map.ts`
- Modify: `packages/core/src/host/types.ts`
- Modify: `packages/core/src/host/plugin-host.ts`

**Step 1: Write failing contract tests**

Add compile-time assertions showing that `PluginDiagnostic.message`, `PluginInfo.error`, the error array, and `PluginInfo.contributes` cannot be mutated. Update the activation/deactivation runtime tests to require diagnostics shaped only as `{ message }`, with no `stack` or `cause`, and require the `PluginInfo` root, its diagnostic(s), and its contributions array to be frozen.

**Step 2: Run tests to verify RED**

Run: `npm test --workspace @lumora/core -- plugin-host.test.ts`

Expected: existing `Error` instances expose `stack`; `PluginInfo` snapshots and deactivation arrays are not deeply frozen.

Run: `npm run typecheck --workspace @lumora/core`

Expected: new `@ts-expect-error` assertions are unused while the DTO remains writable or `PluginInfo.error` remains `unknown`.

**Step 3: Implement the shared summary projection**

Replace `Readonly<Error>` with:

```ts
export interface PluginDiagnostic {
  readonly message: string;
}
```

Declare `PluginInfo` fields readonly and type `error` as `PluginDiagnostic | ReadonlyArray<PluginDiagnostic>`. Project every internal error to a plain `{ message }` summary and return `deepFreeze(...)` snapshots from record `info()`. Emit the same summary DTO from `plugin:state-changed`; never construct or expose a public `Error`.

**Step 4: Run tests to verify GREEN**

Run: `npm test --workspace @lumora/core -- plugin-host.test.ts`

Expected: plugin diagnostics contain only stable host-owned fields and all public snapshots are frozen.

Run: `npm run typecheck --workspace @lumora/core`

Expected: all `@ts-expect-error` directives are consumed and Core typechecking passes.

### Task 2: Recursively readonly AI DTO declarations

**Files:**
- Modify: `packages/core/test/ai-storyboard.test.ts`
- Modify: `packages/core/src/ai/storyboard.ts`
- Modify: `packages/core/src/services.ts`

**Step 1: Write failing type and runtime tests**

Replace the local `ExpectedAiService` shape with the real `AiService` and `GenerationTask` types. Add compile-time negative assignments for task status, error message/retry metadata, brief, draft shot, provider/model fields, and provider/model arrays. Add runtime assertions for `Object.isFrozen` on list/submit/get/wait roots and their nested provider, model, cost, brief, draft, shots, and error objects.

**Step 2: Run tests to verify RED**

Run: `npm test --workspace @lumora/core -- ai-storyboard.test.ts`

Expected: returned task/provider objects accept mutation and nested `Object.isFrozen` assertions fail.

Run: `npm run typecheck --workspace @lumora/core`

Expected: readonly `@ts-expect-error` directives are unused.

**Step 3: Declare the object graph readonly**

Mark fields in `CreativeBrief`, cost/model, draft/shot, `AiProviderErrorData`, `GenerationTask`, and `StoryboardProviderInfo` readonly. Use `ReadonlyArray` for public collections, including provider models and draft shots. Keep provider request inputs compatible with readonly values.

**Step 4: Freeze every public snapshot**

Implement a task snapshot helper equivalent to:

```ts
function publicTaskSnapshot(task: GenerationTask): GenerationTask {
  return deepFreeze(structuredClone(task));
}
```

Use it in submit, get, both wait paths, and completion delivery. Build `listStoryboardProviders()` as a cloned, deep-frozen readonly array.

**Step 5: Run tests to verify GREEN**

Run: `npm test --workspace @lumora/core -- ai-storyboard.test.ts`

Expected: all snapshots reject mutation, remain isolated from Core state, and preserve existing task behavior.

Run: `npm run typecheck --workspace @lumora/core`

Expected: the recursive readonly contract compiles across all consumers.

### Task 3: Polling/waiting diagnostic parity

**Files:**
- Modify: `packages/core/test/ai-storyboard.test.ts`

**Step 1: Add the shared assertion**

Create a helper accepting real `GenerationTask` values and asserting the exact public failure summary: fixed `code`, `message`, `retryable`, and `costKnown`, with no `cause`, `responseBody`, provider marker, or additional error keys.

**Step 2: Exercise both public paths**

In the hostile provider diagnostic regression, run the same helper against the `waitForGenerationTask()` result and the subsequent `getGenerationTask()` snapshot. Assert both roots and error DTOs are frozen and are independent object identities.

**Step 3: Run the focused suite**

Run: `npm test --workspace @lumora/core -- ai-storyboard.test.ts plugin-host.test.ts`

Expected: both files pass with identical polling/waiting diagnostics.

### Task 4: Full verification and delivery

**Files:**
- Verify all files changed from `7d727511c1d0607cefde0ee7051dfbe34efe2cc9`

**Step 1: Run repository gates**

Run: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run e2e`, `npm run smoke:pack`, `npm run smoke:pack:boundary`, `git diff --check 7d727511c1d0607cefde0ee7051dfbe34efe2cc9`, and `openspec validate --all --strict --no-interactive`.

Expected: all commands pass; only documented pre-existing warnings/skips remain.

**Step 2: Request independent review**

Review the complete uncommitted diff against this plan. Resolve every Critical or Important finding and rerun proportional tests.

**Step 3: Commit and push**

Create one scoped TML-239 commit, push `HEAD` to `agent/frontend/tml-55-ai-storyboard`, and verify local HEAD, the remote branch, and `refs/pull/8/head` are identical.

**Step 4: Update Multica state**

Set `delivery_head` to the verified exact SHA, post one concise result comment with gate counts and residual warnings, and move TML-239 to `in_review`. Do not approve, merge, or close PR #8.
