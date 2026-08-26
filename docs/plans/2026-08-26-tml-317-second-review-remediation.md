# TML-317 Second Review Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Close the four remaining review findings around request projection, model-catalog failures, runtime-only key clearing, and response-body error classification while strengthening late-result cancellation barriers.

**Architecture:** Core will own one provider-neutral model-catalog resolver that validates hostile runtime values and emits a fixed `provider_unavailable` error for both Chat and Storyboard. The OpenAI-compatible adapter will validate and project messages before serialization, distinguish JSON syntax failures from body transport failures, and keep abort/deadline precedence. Studio will preserve only trusted host errors, while the settings panel will update the key independently from dirty endpoint/model fields.

**Tech Stack:** TypeScript, React 19, Zod, Vitest/jsdom, Playwright Chromium, Vite workspaces, OpenSpec.

---

### Task 1: Harden Generic Chat request serialization

**Files:**
- Modify: `examples/openai-compatible-plugin/test/provider.test.ts`
- Modify: `examples/openai-compatible-plugin/src/openai-client.ts`

**Steps:**
1. Add tests that pass message objects with extra secret, cyclic, and `BigInt` fields and assert the serialized body contains only exact `role` and `content` keys.
2. Add tests for invalid roles, invalid content, hostile arrays, and hostile message properties; assert `invalid_request` and no fetch call.
3. Run the focused provider test and verify the new cases fail for the expected serialization or error-code reason.
4. Add a bounded, defensive message validator/projector before fetch and serialize only its fresh output.
5. Run the focused provider test and verify all request-boundary cases pass.

### Task 2: Unify model-catalog resolution and public errors

**Files:**
- Create: `packages/core/src/ai/model-catalog.ts`
- Modify: `packages/core/src/ai/storyboard.ts`
- Modify: `packages/core/src/services.ts`
- Modify: `packages/core/test/plugin-host.test.ts`
- Modify: `packages/core/test/ai-storyboard.test.ts`
- Modify: `packages/studio/src/components/storyboard/StoryboardWorkspace.tsx`
- Modify: `packages/studio/test/storyboard-workspace.test.tsx`

**Steps:**
1. Add table-driven Chat and Storyboard tests for resolver throws, non-array/hostile/iterator failures, empty and oversized catalogs, invalid entries, and duplicate IDs; assert fixed `provider_unavailable` data with no private text.
2. Add a Studio test where submission throws a host `AiProviderRequestError`; assert its stable code/message survives, while the existing unknown-error fallback remains `invalid_request`.
3. Run the focused Core and Studio tests and verify the new cases fail with raw errors, missing providers, or the wrong Studio code.
4. Implement one generic catalog resolver with a strict 1..100 bound, defensive iteration, entry validation, uniqueness, and fixed host-owned error construction.
5. Route Chat and Storyboard discovery/submission through the helper, preserving current model re-resolution and validated request-model dispatch.
6. Update Studio submission handling to recognize only the host error class and copy its normalized data.
7. Run the focused Core and Studio tests until green.

### Task 3: Clear only the runtime API key

**Files:**
- Modify: `examples/openai-compatible-plugin/test/settings-panel.test.tsx`
- Modify: `examples/openai-compatible-plugin/src/SettingsPanel.tsx`

**Steps:**
1. Add button-click and keyboard-activation regressions that begin with an existing saved key plus dirty endpoint/model drafts.
2. Assert clearing removes the runtime key while preserving both input drafts and leaving persisted/exportable settings free of the key.
3. Run the focused panel test and verify snapshot subscription currently overwrites dirty fields.
4. Split key synchronization from persisted endpoint/model synchronization so key-only store events cannot replace drafts.
5. Run the focused panel and config tests until green.

### Task 4: Classify response-body failures and late completion

**Files:**
- Modify: `examples/openai-compatible-plugin/test/provider.test.ts`
- Modify: `examples/openai-compatible-plugin/test/plugin.test.ts`
- Modify: `e2e/storyboard.spec.ts`
- Modify: `examples/openai-compatible-plugin/src/openai-client.ts`

**Steps:**
1. Add independent invalid-JSON and errored-stream tests expecting non-retryable `schema_invalid` and retryable `network_error` without native details.
2. Strengthen caller, lifecycle, and deadline body-stage tests with an abort-ignoring controlled body and an explicit post-release reader/application completion barrier.
3. Add integration assertions that late released bodies cannot mutate task, draft, or project state.
4. Run focused tests and verify transport failures are currently misclassified and late completion is not fully observed.
5. Classify only `SyntaxError` from `response.json()` as schema failure; map other body read/decode failures to retryable network errors after checking caller/lifecycle/deadline state.
6. Run focused Provider/plugin/Studio and Playwright tests until green.

### Task 5: Verify and deliver the exact head

**Files:**
- Modify only if required by behavior: `openspec/changes/tml-297-openai-compatible-provider/design.md`
- Modify only if required by behavior: `openspec/changes/tml-297-openai-compatible-provider/specs/openai-compatible-storyboard-provider/spec.md`

**Steps:**
1. Run focused Provider/Core/Studio tests and record pass counts.
2. Run root `typecheck`, `lint`, full Vitest, `build`, Chromium Playwright, pack smoke, boundary smoke, `git diff --check`, and strict OpenSpec validation.
3. Review the exact diff for provider coupling, secret retention, unrelated churn, and worktree cleanliness.
4. Commit once on the isolated task branch and push the exact commit over SSH to `agent/agent/5b705630`.
5. Verify the pushed branch and PR #9 head, confirm `24d97a0452f3efffd04edbf77886cebf0cc795f8` remains an ancestor, and report any GitHub API collaboration error separately from Git delivery.
