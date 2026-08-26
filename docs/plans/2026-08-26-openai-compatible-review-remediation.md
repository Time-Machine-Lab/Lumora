# OpenAI-Compatible Review Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Fix host configuration isolation, dynamic Chat model consistency, and response-body cancellation semantics for the OpenAI-compatible provider.

**Architecture:** Core will expose a provider-neutral, plugin-scoped settings interface whose backing store belongs to one host instance. Studio will supply a browser-backed store with a per-Studio namespace, while direct `PluginHost` users receive isolated in-memory settings. Both Chat and storyboard paths will resolve their current model catalogs at submission time, and the HTTP client will race body parsing against the composed abort/deadline signal.

**Tech Stack:** TypeScript, React 19, Zod, Vitest/jsdom, Playwright Chromium, Vite workspaces, OpenSpec.

---

### Task 1: Add host-scoped provider-neutral settings

**Files:**
- Modify: `packages/core/src/host/types.ts`
- Modify: `packages/core/src/host/plugin-host.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `packages/studio/src/runtime/studio-runtime.ts`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Create: `packages/studio/src/runtime/browser-plugin-settings.ts`
- Test: `packages/core/test/plugin-host.test.ts`
- Test: `examples/openai-compatible-plugin/test/plugin.test.ts`

**Steps:**
1. Add failing Core tests proving settings survive disable/enable within one host and remain isolated between two hosts.
2. Run the focused Core test and confirm the plugin context has no scoped settings API.
3. Add `PluginSettings` and `PluginSettingsStorage`, a per-host memory default, and a scoped context facade keyed by plugin instance.
4. Add a Studio browser storage adapter keyed by a stable explicit namespace or React `useId` fallback.
5. Run focused Core and Studio tests until green.

### Task 2: Move provider configuration into the host scope

**Files:**
- Modify: `examples/openai-compatible-plugin/src/config.ts`
- Modify: `examples/openai-compatible-plugin/src/index.tsx`
- Modify: `examples/openai-compatible-plugin/test/config.test.ts`
- Modify: `examples/openai-compatible-plugin/test/plugin.test.ts`
- Modify: `examples/openai-compatible-plugin/test/settings-panel.test.tsx`

**Steps:**
1. Add a failing two-host regression: A and B save different endpoint/model values, A disable/enable restores A, and neither persisted record contains either API key.
2. Run the plugin test and confirm A reloads B from the shared global key.
3. Construct `ProviderConfigStore` from `context.settings`; persist only one scoped JSON value containing exact `endpoint` and `model` fields.
4. Preserve runtime-only key clearing and make unavailable persistent storage report a save error.
5. Run all plugin tests until green.

### Task 3: Unify dynamic Chat discovery, validation, and requests

**Files:**
- Modify: `packages/core/src/contributions/types.ts`
- Modify: `packages/core/src/contributions/contribution-registry.ts`
- Modify: `packages/core/src/services.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `examples/openai-compatible-plugin/src/index.tsx`
- Test: `packages/core/test/plugin-host.test.ts`
- Test: `examples/openai-compatible-plugin/test/plugin.test.ts`

**Steps:**
1. Add a failing test that changes model A to B, rejects stale A, accepts B, and captures B in the outgoing JSON.
2. Run the focused tests and confirm Chat still validates against the activation snapshot.
3. Introduce a neutral `AiChatModelCatalog` array-or-resolver contract and resolve a validated fresh catalog immediately before Chat dispatch.
4. Make the provider send the host-validated `request.model` rather than substituting its latest snapshot model.
5. Run focused Core/plugin tests until green.

### Task 4: Preserve body-stage cancellation and timeout codes

**Files:**
- Modify: `examples/openai-compatible-plugin/src/openai-client.ts`
- Modify: `examples/openai-compatible-plugin/test/provider.test.ts`
- Modify: `examples/openai-compatible-plugin/test/plugin.test.ts`
- Modify: `e2e/storyboard.spec.ts`

**Steps:**
1. Add body-stall tests for caller abort, lifecycle abort, and deadline; each must settle with `cancelled`, `cancelled`, and `timeout`, respectively.
2. Add precise request-body key assertions and raw-body API-key negative assertions.
3. Run tests and confirm body-stage abort currently reports `schema_invalid` or hangs.
4. Race `response.json()` with the composed controller signal and prioritize cancellation/deadline state before schema classification.
5. Add a late-body-success barrier and assert no successful draft or project mutation after cancellation.
6. Run focused provider/plugin/Studio and Playwright tests until green.

### Task 5: Verify and deliver the fixed commit

**Files:**
- Modify: `openspec/changes/tml-297-openai-compatible-provider/specs/openai-compatible-storyboard-provider/spec.md`
- Modify: `openspec/changes/tml-297-openai-compatible-provider/design.md`

**Steps:**
1. Record host-scoped settings and body-stage cancellation requirements in OpenSpec.
2. Run focused Provider/Core/Studio tests, root typecheck, lint, full Vitest, root and embedded-host builds, Chromium Playwright, pack smoke, boundary smoke, `git diff --check`, and OpenSpec strict validation.
3. Review the exact diff for provider boundary violations and credential leakage.
4. Commit on the task branch, push the resulting commit to `agent/agent/5b705630` over SSH, and verify `46e749e5d2eb22478c3c13bf6b21a6847322e17f` remains an ancestor.
5. Attempt PR creation once; if GitHub authentication rejects it, record the raw error without blocking delivery.
