## Context

Storyboard providers contribute a host-validated capability with model descriptors and an asynchronous generator. The existing array-only catalog is copied during contribution registration, so changing a configurable provider's model cannot affect the next task without disabling and re-registering the plugin. The embedded browser host also has no server proxy or credential vault service; the launch provider must call the endpoint directly and must not place its key in project or browser persistence.

## Goals / Non-Goals

**Goals:**

- Let users configure an HTTPS or local-loopback OpenAI-compatible endpoint, any valid model name, and an optional runtime-only API key.
- Generate exactly the requested structured storyboard through Chat Completions and retain the configured provider/model in adopted shot lineage.
- Preserve host-owned schema validation, immutable task snapshots, no-retry behavior, cancellation, and plugin removal cleanup.
- Distinguish configuration, authentication, model/endpoint, timeout, rate-limit, service availability, browser network/CORS, and response-shape failures without exposing provider data or credentials.
- Keep the Mock provider behavior and static model catalog unchanged.

**Non-Goals:**

- Image generation or reference-image providers.
- Vendor marketplaces, account billing, model discovery APIs, server-side credential storage, or a CORS/proxy bypass.
- Automatic retry or response-body diagnostics.

## Decisions

1. `AiStoryboardCapability.models` accepts either a static readonly array or a zero-argument resolver. Registration validates callable shape without invoking plugin code; discovery and submission invoke and fully validate a fresh array, including ids, costs, bounds, and uniqueness. A failed resolver makes only that provider unavailable.

2. The plugin owns all OpenAI-specific behavior. Core and Studio do not know the endpoint, Authorization header, Chat Completions fields, prompt format, or response envelope. The plugin returns parsed JSON and the existing host validates it as a storyboard payload before creating any draft.

3. Core exposes a provider-neutral `PluginSettings` facade scoped by the host to the plugin instance. Direct `PluginHost` instances default to independent in-memory stores; Studio supplies localStorage persistence under a per-Studio namespace and then a plugin instance namespace. Endpoint and model share one non-sensitive record inside that scope and are not part of `Project.pluginData`; the API key exists only in React state and the plugin config store's in-memory snapshot, is sent only as a Bearer header, and is cleared on deactivate.

4. Endpoint normalization accepts HTTPS everywhere and HTTP only for exact localhost or loopback IP hosts. It rejects embedded credentials, query strings, and fragments, then accepts either a base path or a full `/chat/completions` path. The UI states the browser CORS prerequisite and does not attempt a bypass.

5. One timeout-aware request path serves connection tests, chat, and storyboard generation. It never reads a failed HTTP response body, never logs request data, never retries, and maps only status/signal/shape information to typed errors. Reading the success body races the same composed signal as `fetch`, so caller cancellation, lifecycle cancellation, and deadline retain their stable codes after headers arrive and an abort-ignoring late body cannot win. The host replaces provider messages with fixed summaries at the task boundary.

6. Plugin deactivation aborts a lifecycle controller in addition to the host's provider-task cancellation. This covers panel connection tests as well as generation, clears the API key, and leaves only the non-sensitive persisted endpoint/model for reactivation.

7. Plugin settings remain a normal panel contribution. A generic PanelHost improvement scrolls newly selected panel content into the closest container on narrow layouts; this behavior applies equally to every plugin.

8. The generic Chat model catalog uses the same provider-neutral static-array-or-resolver shape as configurable storyboard discovery. Core resolves and validates the latest Chat catalog immediately before dispatch and passes the already accepted `request.model` unchanged; the plugin never substitutes a newer snapshot model after validation.

## Risks / Trade-offs

- [A model resolver executes plugin code during discovery] -> Validate every returned catalog, catch resolver failures per provider, and never persist its result in host state.
- [Browser direct calls depend on vendor CORS configuration] -> State the prerequisite, classify network/CORS failures, and allow local loopback HTTP for development without weakening remote transport policy.
- [A key could leak through an exception or failed response] -> Do not consume failed bodies, use fixed error construction, prohibit credential/query endpoint URLs, and search storage/export/event surfaces in E2E.
- [Configuration can change between discovery and submission] -> Resolve again during submission and pass the accepted model into the immutable task. A stale model is rejected before any provider request.
- [Two embedded Studios share one browser origin] -> Namespace browser settings by Studio and plugin instance; embedders provide a stable Studio namespace when settings must survive component remounts.
- [Compatible providers vary in optional OpenAI fields] -> Use the common non-streaming `model` and `messages` contract; do not require vendor-specific response-format extensions.

## Migration Plan

No project migration is required. Existing static-array provider contributions remain valid. The embedded host registers the new plugin after Mock so existing default demonstrations and tests continue selecting Mock unless users choose the new provider.

## Open Questions

None for launch scope.
