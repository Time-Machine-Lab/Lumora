# AI Storyboard Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Deliver a provider-neutral, offline-testable flow from a creative brief to validated storyboard drafts and editable persisted shots.

**Architecture:** Extend the existing `aiProvider` contribution with an explicit `ai.storyboard.generate` capability and keep task execution in the shared core AI service. Validate every provider payload before exposing it, normalize and redact all errors, and adopt validated draft shots through one atomic `SceneEditor` mutation. The Studio opens a focused storyboard workspace over the editor while the Mock plugin supplies deterministic success and failure modes.

**Tech Stack:** TypeScript, Zod, React 19, Vitest, Testing Library, Playwright, existing Lumora plugin/runtime/editor APIs.

---

### Task 1: Storyboard domain and task lifecycle

**Files:**
- Create: `packages/core/src/ai/storyboard.ts`
- Modify: `packages/core/src/contributions/types.ts`
- Modify: `packages/core/src/services.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Test: `packages/core/test/ai-storyboard.test.ts`

**Steps:**
1. Write failing tests for valid draft parsing, invalid schema rejection, successful task completion, timeout/rate-limit normalization, cancellation, unknown-cost no-retry behavior, and credential redaction.
2. Run `npx vitest run packages/core/test/ai-storyboard.test.ts` and confirm failures are caused by missing APIs.
3. Add strict Zod schemas and public types for `CreativeBrief`, `StoryboardDraft`, `GenerationTask`, cost hints, provider errors, storyboard models, and optional reference-image capability.
4. Add `listStoryboardProviders`, `submitStoryboard`, `getGenerationTask`, `waitForGenerationTask`, and `cancelGenerationTask` to the shared AI service. A task executes exactly once and never retries automatically.
5. Run the focused core tests and keep the existing chat API compatible.

### Task 2: Persisted editable Shot metadata and atomic adoption

**Files:**
- Modify: `packages/core/src/scene/types.ts`
- Modify: `packages/core/src/scene/validate.ts`
- Modify: `packages/core/src/editor/scene-editor.ts`
- Modify: `packages/core/src/scene/create.ts`
- Test: `packages/core/test/scene-editor-storyboard.test.ts`

**Steps:**
1. Write failing tests proving three accepted drafts create three shots with shot size, movement, duration, prompt, and AI provenance in one undoable mutation.
2. Add optional storyboard metadata to `ShotClipData` and strict schema validation for every field.
3. Add `SceneEditor.addShots(shots, label)` that clones, validates, rejects duplicate IDs, and commits the entire batch atomically.
4. Verify invalid metadata writes nothing and successful adoption can be edited, undone, and redone.

### Task 3: Offline Mock storyboard provider

**Files:**
- Modify: `examples/mock-plugin/src/index.tsx`
- Modify: `examples/mock-plugin/lumora.plugin.json`
- Test: `examples/mock-plugin/test/storyboard.test.ts`

**Steps:**
1. Write failing plugin-host tests for success, timeout, rate limiting, invalid schema, and cancellation.
2. Register `ai.storyboard.generate` with deterministic models for each scenario and explicit known/unknown cost hints.
3. Generate the requested number of useful draft shots from the brief without network access.
4. Verify cancellation observes `AbortSignal` and no scenario logs or returns credentials.

### Task 4: Studio generation and adoption workflow

**Files:**
- Create: `packages/studio/src/components/storyboard/StoryboardWorkspace.tsx`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Modify: `packages/studio/src/components/Toolbar.tsx`
- Modify: `packages/studio/src/lumora.css`
- Test: `packages/studio/test/storyboard-workspace.test.tsx`

**Steps:**
1. Write failing UI tests for validation, provider/model selection, cost display, loading/cancel/error states, editable drafts, individual/all adoption, and editing an adopted shot.
2. Add a toolbar entry and a responsive workspace with brief controls on the left and draft/adopted-shot views on the right.
3. Bind generation to the current project session, cancel stale tasks on close/project switch, and show diagnostic error codes without raw provider payloads.
4. Map accepted drafts to sequential `ShotClipData` records and use atomic batch adoption for "accept all".
5. Keep adopted shot fields editable through `SceneEditor.updateShot` and expose camera binding and deletion.

### Task 5: Browser acceptance and delivery checks

**Files:**
- Create: `e2e/storyboard.spec.ts`
- Modify: `README.md`

**Steps:**
1. Add browser tests for the three-shot happy path, invalid-schema no-write behavior, and cancellation.
2. Run focused tests after each red/green cycle, then `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run e2e`.
3. Start the dev server in the foreground during verification, capture desktop and mobile screenshots, and check for overflow, overlap, focus, and blank-render failures.
4. Run `git diff --check` and inspect the final diff. Do not commit, push, or create a PR without project-manager authorization.
