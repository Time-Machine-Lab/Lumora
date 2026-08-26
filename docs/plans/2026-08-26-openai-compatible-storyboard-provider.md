# OpenAI-Compatible Storyboard Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Add a real OpenAI-compatible text provider whose endpoint, model, and optional runtime-only API key can be configured in the UI and used to generate validated storyboard shots.

**Architecture:** Keep all OpenAI HTTP and response logic in a new plugin package. Extend the provider-neutral Core contract so model descriptors may be resolved dynamically at discovery and submission time, allowing any configurable provider to refresh its current model without re-registering; Studio continues to consume only neutral provider/model metadata. Persist only the endpoint and model in a plugin-owned non-sensitive local setting, hold the API key solely in module/React memory, and rely on the existing host task boundary for final `StoryboardDraft` validation and provider-removal cancellation.

**Tech Stack:** TypeScript, React 19, Zod, Vitest/jsdom, Vite workspaces, Playwright Chromium, OpenSpec.

---

### Task 1: Specify the provider-neutral dynamic model contract

**Files:**
- Modify: `packages/core/src/ai/storyboard.ts`
- Modify: `packages/core/src/services.ts`
- Modify: `packages/core/src/contributions/types.ts`
- Modify: `packages/core/src/contributions/contribution-registry.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Test: `packages/core/test/ai-storyboard.test.ts`
- Test: `packages/core/test/contribution-registry.test.ts`

**Steps:**
1. Add a failing Core test where `storyboard.models` is a zero-argument resolver, change the resolver's backing model, and assert both discovery and the next submitted task use the new descriptor.
2. Add failing normalization cases for authentication and browser-network failures, asserting fixed host-owned messages and no provider text leakage.
3. Run the focused Core tests and confirm failures arise from the current static-array schema and unknown codes.
4. Introduce `StoryboardModelCatalog = ReadonlyArray<StoryboardModelDescriptor> | (() => ReadonlyArray<StoryboardModelDescriptor>)`, validate either form without invoking accessors during contribution registration, and resolve/validate a fresh catalog in `listProviders` and `submit`.
5. Extend `AiProviderErrorCode` with provider-neutral `authentication_failed` and `network_error` summaries; re-export new public types through Core and plugin-sdk.
6. Run focused tests and existing Mock provider tests; preserve static-array behavior and immutable public snapshots.

### Task 2: Build the isolated OpenAI-compatible plugin with tests first

**Files:**
- Create: `examples/openai-compatible-plugin/package.json`
- Create: `examples/openai-compatible-plugin/tsconfig.json`
- Create: `examples/openai-compatible-plugin/tsconfig.build.json`
- Create: `examples/openai-compatible-plugin/vite.config.ts`
- Create: `examples/openai-compatible-plugin/vitest.config.ts`
- Create: `examples/openai-compatible-plugin/lumora.plugin.json`
- Create: `examples/openai-compatible-plugin/src/config.ts`
- Create: `examples/openai-compatible-plugin/src/openai-client.ts`
- Create: `examples/openai-compatible-plugin/src/SettingsPanel.tsx`
- Create: `examples/openai-compatible-plugin/src/index.tsx`
- Create: `examples/openai-compatible-plugin/test/config.test.ts`
- Create: `examples/openai-compatible-plugin/test/provider.test.ts`
- Create: `examples/openai-compatible-plugin/test/settings-panel.test.tsx`

**Steps:**
1. Write failing URL/config tests covering HTTPS, localhost/loopback HTTP, base-URL completion, forbidden remote HTTP, credentials/query/hash rejection, model validation, and persistence of endpoint/model only.
2. Write failing fetch tests asserting request URL/model/messages, optional Bearer header, empty-key omission, standard `choices[0].message.content` parsing, and exact structured storyboard content.
3. Add failing table tests for 401/403, 404, 408, 429 with `Retry-After`, 5xx, network/CORS, request timeout, invalid JSON, invalid outer response, invalid content JSON, external cancellation, and no retry.
4. Add a failing lifecycle test proving deactivation aborts pending connection tests and clears the key while reactivation reloads only non-sensitive settings.
5. Add failing React tests for validation, save, test-connection status, password semantics, CORS notice, and narrow-layout-safe structure.
6. Implement a config store with one localStorage record containing only `{ endpoint, model }`; keep `apiKey` in memory and never pass it to events, logs, project data, storage, or error text.
7. Implement a timeout-aware fetch client with sanitized error mapping, no retries, exact standard Chat Completions parsing, JSON content parsing, and composed cancellation.
8. Implement the settings panel and contribute it alongside the provider. Expose the configured model through the dynamic neutral catalog and read the latest endpoint/model/key at request time.
9. Run the plugin test suite until green, then run Core, SDK, and Mock suites.

### Task 3: Integrate the plugin and real-browser flow

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.workspace.ts`
- Modify: `examples/embedded-host/package.json`
- Modify: `examples/embedded-host/src/App.tsx`
- Modify: `packages/studio/src/components/storyboard/StoryboardWorkspace.tsx`
- Modify: `packages/studio/src/lumora.css`
- Modify: `packages/studio/test/storyboard-workspace.test.tsx`
- Modify: `e2e/storyboard.spec.ts`

**Steps:**
1. Add a failing Studio regression that changes a dynamic provider's configured model, emits the neutral contribution refresh event, and verifies the next request and adopted shot lineage use the new model while the Mock provider remains selectable.
2. Reconcile selected provider/model state when refreshed discovery data changes; retain the existing static select contract and unknown-cost display.
3. Register the OpenAI plugin in the embedded host and add it to build/test workspaces without changing the reviewed PR #8 branch.
4. Add a Playwright route-backed fake OpenAI endpoint. Configure endpoint/model/key through the settings panel, test the connection, generate three shots, edit one, adopt all, and assert model lineage plus Authorization header.
5. Add browser assertions that localStorage, sessionStorage, IndexedDB-visible project state, downloads/event log, and public errors never contain the test key.
6. Cover changed configuration, empty key, 401, 429, 5xx, timeout, network failure, invalid JSON/schema, cancellation, disable/re-enable clearing key, and no automatic retry.
7. Exercise desktop and narrow embedded/mobile viewports and fix overflow, focus, disabled, loading, error, and status states.

### Task 4: Record the OpenSpec and run delivery gates

**Files:**
- Create: `openspec/changes/tml-297-openai-compatible-provider/proposal.md`
- Create: `openspec/changes/tml-297-openai-compatible-provider/design.md`
- Create: `openspec/changes/tml-297-openai-compatible-provider/tasks.md`
- Create: `openspec/changes/tml-297-openai-compatible-provider/specs/openai-compatible-storyboard-provider/spec.md`

**Steps:**
1. Document configuration, credential isolation, URL policy, request/response behavior, stable errors, cancellation, lifecycle, and non-goals as SHALL requirements with scenarios.
2. Run `npx openspec validate tml-297-openai-compatible-provider --strict` and fix all findings.
3. Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run e2e -- --project=chromium` (or the repository's single Chromium project), `npm run smoke:pack`, `npm run smoke:pack:boundary`, and `git diff --check`.
4. Inspect the final diff for key literals, OpenAI-specific fields outside the plugin, accidental project persistence, and changes to PR #8's remote branch.
5. Commit on the task branch, push that branch, and open a separate PR whose title contains `TML-297`, targets the same base as PR #8, states dependency on head `c034f7de6d1caa488e2cd466aba49f4f0cb2f2a3`, and contains no close intent.
