## ADDED Requirements

### Requirement: Configurable compatible endpoint and model
The OpenAI-compatible provider SHALL expose a discoverable settings panel where a user can edit, validate, and save a Chat Completions base/full endpoint and an arbitrary model name. Discovery and the next storyboard submission SHALL resolve the latest saved model without source changes or plugin re-registration, while static providers SHALL retain their existing catalog behavior.

#### Scenario: User changes the compatible model
- **WHEN** the user saves a different valid model and starts the next storyboard request
- **THEN** provider discovery, the request body, the generation task, the draft, and adopted shot lineage use that new model

#### Scenario: Generic Chat uses the refreshed model
- **WHEN** model A was active, the user saves model B, and a generic Chat request is submitted
- **THEN** model B is accepted and sent unchanged, while stale model A is rejected before any network request

#### Scenario: Generic Chat projects untrusted messages
- **WHEN** a runtime Chat message contains valid `role` and `content` values plus extra, cyclic, or non-JSON fields
- **THEN** the provider receives and serializes only a fresh `{ role, content }` object, while invalid roles, content, arrays, or iterators fail before provider dispatch as sanitized `invalid_request`

#### Scenario: A dynamic model catalog is unavailable
- **WHEN** either a Chat or Storyboard catalog resolver throws or returns an empty, oversized, malformed, duplicate, or non-iterable catalog
- **THEN** submission fails as sanitized `provider_unavailable`, no provider request runs, and Studio preserves that trusted host code and message

#### Scenario: User enters an unsafe endpoint
- **WHEN** the endpoint is invalid, uses remote HTTP, contains credentials, query parameters, or a fragment
- **THEN** save and connection test are rejected before a network request with actionable configuration feedback

#### Scenario: User enters a local development endpoint
- **WHEN** the endpoint uses HTTP with localhost, 127.0.0.0/8, or IPv6 loopback
- **THEN** the provider accepts it and normalizes a base path to its Chat Completions path

### Requirement: Runtime-only API key isolation
The provider SHALL allow an empty API key. A non-empty key SHALL be held only in current runtime memory and sent only in the request Authorization Bearer header. It MUST NOT be written to Project, pluginData, localStorage, sessionStorage, IndexedDB, project packages, downloads, event payloads, logs, URLs, or public error data.

#### Scenario: Authenticated compatible request
- **WHEN** the user saves a non-empty key and submits a request
- **THEN** the request contains `Authorization: Bearer <key>` and no request body or observable host state contains the key

#### Scenario: Unauthenticated local request
- **WHEN** the API key is empty
- **THEN** the provider omits the Authorization header and still submits the request

#### Scenario: Plugin is disabled and enabled
- **WHEN** a configured plugin with a runtime key is disabled and later enabled
- **THEN** the endpoint and model are restored, the key is empty, and every request active during disable is cancelled

#### Scenario: Two host instances save different settings
- **WHEN** two Host or Studio instances on the same origin save different endpoint/model/key values and one plugin is disabled and enabled
- **THEN** each instance restores only its own endpoint/model, neither key is persisted, and one instance's lifecycle does not cancel the other

#### Scenario: User clears a key with unsaved setting drafts
- **WHEN** a runtime key exists, the user edits endpoint or model without saving, and activates Clear Key by pointer or keyboard
- **THEN** only the runtime key is cleared, both unsaved input drafts remain unchanged, and persistence and exports still contain no key

### Requirement: Browser direct connection feedback
The settings panel SHALL state that the endpoint must permit the current browser origin through CORS and SHALL provide an immediate connection test. The test SHALL distinguish invalid configuration, authentication failure, unsupported endpoint/model, browser network/CORS failure, timeout, rate limit, provider unavailability, and invalid Chat Completions response structure without exposing response bodies.

#### Scenario: Connection succeeds
- **WHEN** the endpoint returns a standard non-empty `choices[0].message.content`
- **THEN** the panel reports success and re-enables its controls

#### Scenario: Browser cannot reach the endpoint
- **WHEN** fetch fails because of network or CORS policy
- **THEN** the panel reports a browser network/CORS failure and does not retry

#### Scenario: Endpoint rejects authentication
- **WHEN** the endpoint returns HTTP 401 or 403
- **THEN** the panel reports authentication failure without reading or displaying the response body

### Requirement: Structured storyboard Chat Completions protocol
The plugin SHALL convert a valid CreativeBrief into a constrained non-streaming Chat Completions request using the configured model and parse standard `choices[].message.content` JSON. The host SHALL validate the parsed value against its StoryboardDraft payload schema and exact requested shot count before exposing a draft or allowing adoption.

#### Scenario: Compatible endpoint returns three valid shots
- **WHEN** a three-shot brief receives valid structured content
- **THEN** the user can edit and adopt all three shots with shot size, movement, duration, prompt, provider id, and configured model lineage

#### Scenario: Content is not JSON
- **WHEN** the success envelope contains malformed JSON text
- **THEN** the task fails with `schema_invalid`, exposes no draft, and makes no project change

#### Scenario: JSON does not satisfy the host schema
- **WHEN** parsed JSON is missing required storyboard or shot fields
- **THEN** host validation fails with `schema_invalid`, exposes no draft, and makes no project change

### Requirement: Stable sanitized failures without retry
The provider SHALL make exactly one HTTP attempt per user submission and SHALL map 401/403 to `authentication_failed`, 404 to `model_unsupported`, 408/deadline to `timeout`, 429 to `rate_limited`, 5xx to `provider_unavailable`, browser fetch failure to `network_error`, invalid response/content to `schema_invalid`, and caller abort to `cancelled`. Public task errors MUST use host-owned summaries and MUST NOT expose response text, headers, stack traces, credential-bearing URLs, or keys. Cost SHALL be unknown when no provider estimate exists.

#### Scenario: Rate limit response includes Retry-After
- **WHEN** the endpoint returns HTTP 429 with a valid Retry-After value
- **THEN** the task exposes bounded retry timing metadata but does not automatically retry

#### Scenario: Provider returns a private failure body
- **WHEN** any non-success response body contains private provider or credential data
- **THEN** the client does not consume the body and no task, event, log, or UI text contains that data

#### Scenario: Success body contains invalid JSON syntax
- **WHEN** headers report success but `response.json()` rejects with a JSON `SyntaxError`
- **THEN** the request fails once as non-retryable `schema_invalid` without exposing the body

#### Scenario: Success body transport fails
- **WHEN** headers report success but the body stream, connection, or decoder fails for a non-syntax reason
- **THEN** the request fails once as retryable `network_error` without exposing native transport details

#### Scenario: User cancels generation
- **WHEN** the host abort signal fires before response completion
- **THEN** fetch is aborted, the task becomes cancelled, and a late provider success cannot create a draft or project shots

#### Scenario: Cancellation or deadline occurs while reading the body
- **WHEN** headers have arrived but the response body stalls and caller abort, plugin lifecycle abort, or the request deadline fires
- **THEN** the request settles as `cancelled`, `cancelled`, or `timeout` respectively, and an abort-ignoring late body cannot change the terminal task or project
