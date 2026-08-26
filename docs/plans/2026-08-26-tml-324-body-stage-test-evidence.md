# TML-324 Body-Stage Test Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Replace the false late-body completion barriers with observable reader/application completion and cover a real Chromium body-stage cancellation.

**Architecture:** A test utility will provide one controlled response flow whose headers are available while its JSON body ignores abort until explicitly released. Core will retain the already-created task execution promise behind an internal, non-package-exported observer so integration tests can await the real capability/application chain. Playwright will use a local Node HTTP server that flushes headers before cancellation and browser-side instrumentation that observes the production reader cleanup and terminal UI state.

**Tech Stack:** TypeScript, Vitest, React/PluginHost integration tests, Node `http`, Playwright Chromium.

---

### Task 1: Controlled Vitest Body-Stage Fixture

**Files:**
- Create: `examples/openai-compatible-plugin/test/body-stage-response.ts`
- Modify: `examples/openai-compatible-plugin/test/provider.test.ts`

**Step 1: Write the failing test**

Replace the source-Promise `.finally` marker with a shared fixture API that exposes `bodyReadStarted`, `releaseBody()`, and `readerCleanupSettled`. Parameterize caller abort, lifecycle abort, and deadline through the same flow.

**Step 2: Run test to verify it fails**

Run: `npx vitest run examples/openai-compatible-plugin/test/provider.test.ts`

Expected: FAIL because the controlled fixture does not exist yet.

**Step 3: Write minimal implementation**

Implement the fixture with a real `Response`, a body Promise that ignores abort, and a marker attached to the internal request signal's production `removeEventListener` call after `response.json()` started.

**Step 4: Run test to verify it passes**

Run: `npx vitest run examples/openai-compatible-plugin/test/provider.test.ts`

Expected: all provider tests pass and no source-Promise `.finally` barrier remains.

### Task 2: Internal Core Application Completion Observer

**Files:**
- Modify: `packages/core/src/services.ts`
- Modify: `packages/core/test/ai-storyboard.test.ts`

**Step 1: Write the failing test**

Add a Core test that captures the execution observer before cancellation, releases an abort-ignoring provider result, and requires the observer to settle only after the capability/application execution returns while the task remains cancelled.

**Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/ai-storyboard.test.ts`

Expected: FAIL because the internal observer is not implemented.

**Step 3: Write minimal implementation**

Retain each existing `execute()` Promise in an internal map until it settles and expose `waitForStoryboardTaskExecution()` from `services.ts` only, without re-exporting it from `packages/core/src/index.ts` or changing `AiService`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/ai-storyboard.test.ts`

Expected: all Core storyboard tests pass.

### Task 3: Unified Plugin Integration Coverage

**Files:**
- Modify: `examples/openai-compatible-plugin/test/plugin.test.ts`

**Step 1: Write the failing test**

Parameterize caller cancellation, plugin lifecycle abort, and deadline over the shared body-stage fixture. Capture the internal Core execution Promise before termination and require both reader cleanup and application completion before final assertions.

**Step 2: Run test to verify it fails**

Run: `npx vitest run examples/openai-compatible-plugin/test/plugin.test.ts`

Expected: FAIL until the fixture and internal observer are integrated correctly.

**Step 3: Write minimal implementation**

Use fake timers only for the 30-second deadline trigger, restore real timers after termination, and assert terminal code/status, no draft, unchanged project, and no late task overwrite for all three rows.

**Step 4: Run test to verify it passes**

Run: `npx vitest run examples/openai-compatible-plugin/test/plugin.test.ts`

Expected: all plugin integration tests pass.

### Task 4: Real Chromium Body-Stage Cancellation

**Files:**
- Create: `e2e/helpers/body-stage-server.ts`
- Modify: `e2e/storyboard.spec.ts`

**Step 1: Write the failing test**

Replace `page.route(...).fulfill(...)` in the late-success test with a local HTTP server that calls `writeHead()` and `flushHeaders()`, waits for explicit release, then attempts to write the valid success body even after client abort.

**Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/storyboard.spec.ts --grep "body-stage"`

Expected: FAIL until the server helper and browser completion instrumentation are implemented.

**Step 3: Write minimal implementation**

Instrument the page's target fetch to record browser receipt of headers, body-read start, production reader cleanup, and the terminal UI application state. After cancellation, release the server and await both server closure/write completion and the browser markers before checking draft, shot count, and persistence.

**Step 4: Run test to verify it passes**

Run: `npx playwright test e2e/storyboard.spec.ts --grep "body-stage"`

Expected: the body-stage Chromium test passes without `route.fulfill`.

### Task 5: Regression Gates and Delivery

**Files:**
- Modify: `docs/plans/2026-08-26-tml-324-body-stage-test-evidence.md` only if verification findings require clarification.

**Step 1: Run focused regression**

Run the Provider, plugin, Core, and Studio tests named by TML-324.

**Step 2: Run repository gates**

Run root typecheck, lint, full Vitest, build, Chromium Playwright, pack smoke, boundary smoke, both exact diff checks, and OpenSpec strict validation.

**Step 3: Confirm evidence shape**

Use `rg` to prove no source-Promise `.finally` marker remains in the targeted tests and the Chromium body-stage test no longer uses `route.fulfill` for its late success.

**Step 4: Commit and push**

Create one scoped commit, push `HEAD` by SSH to `refs/heads/agent/agent/5b705630`, and verify the remote branch and PR head plus ancestor relationship.
