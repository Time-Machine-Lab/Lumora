## ADDED Requirements

### Requirement: Thumbnail cache reflects visible scene content
The Studio SHALL invalidate shot thumbnails when the active scene, project render data, editor session, or asynchronous render-content generation changes.

#### Scenario: Active scene changes in one session
- **WHEN** the editor switches active scenes without opening a new project session
- **THEN** every shot thumbnail is recaptured for the newly visible scene

#### Scenario: Deferred model content becomes ready
- **WHEN** a model lease resolves after placeholder thumbnails were captured
- **THEN** the render generation changes and the affected thumbnail generation is recaptured

### Requirement: Transient capture failures remain recoverable
The Studio MUST cache only successful image data URLs and SHALL bound retries within one render generation.

#### Scenario: Capture fails then succeeds
- **WHEN** a shot capture returns null transiently and succeeds within the bounded attempts
- **THEN** the successful image is cached and displayed

#### Scenario: Capture exhausts retries
- **WHEN** every bounded attempt fails
- **THEN** no permanent cache entry is written and a later readiness generation can retry

### Requirement: Bound-camera capture is aspect-correct and non-invasive
The Studio SHALL capture a shot's bound perspective camera at the project aspect ratio without changing the visible renderer output or retained renderer state.

#### Scenario: Host and project aspects differ
- **WHEN** the viewport host aspect differs from the project aspect
- **THEN** the encoded thumbnail dimensions follow the project aspect

#### Scenario: Capture completes or throws
- **WHEN** offscreen rendering succeeds or fails
- **THEN** render target, viewport, scissor, clear state, and camera projection state are restored

### Requirement: Project events retain session ownership
Every `project:changed` payload SHALL carry the session token of the project snapshot it contains, and timeline consumers MUST ignore stale events after synchronous nested project opens.

#### Scenario: Earlier listener opens project C while delivering project B
- **WHEN** a `project:changed(B)` listener synchronously opens C before the timeline listener runs
- **THEN** the editor and timeline both reflect C and the stale B payload does not update fps or duration

### Requirement: Endpoint playback state is latest-wins
Non-looping endpoint handling SHALL preserve a synchronous restart performed by a `time:changed` listener and return the controller's final time.

#### Scenario: Endpoint listener restarts playback
- **WHEN** a tick reaches the endpoint and a `time:changed` listener calls `play()`
- **THEN** the final state is playing at time zero, subscribers do not receive a stale final false, and tick returns zero

### Requirement: Global confirmation remains themed
The root-level overwrite confirmation portal SHALL resolve the same theme variables as the Studio root.

#### Scenario: Confirmation is portaled to body
- **WHEN** overwrite confirmation opens
- **THEN** its surface is opaque and its buttons have resolved backgrounds, borders, and text colors

### Requirement: Deterministic playback is accepted through real runs
The AC1 browser acceptance SHALL compare two independent natural playbacks from the same start to the same non-looping endpoint without endpoint seeks.

#### Scenario: Two recorded-camera playbacks complete
- **WHEN** each run starts at zero and naturally stops at the common endpoint
- **THEN** endpoint pose values are exactly equal and endpoint frame pixels satisfy the strict deterministic threshold
