## ADDED Requirements

### Requirement: Recording actions reject stale synchronous continuation
The timeline session SHALL allow only the latest begin, resume, or pause recording operation to write React recording state after a synchronous timeline event boundary. Ownership MUST include operation generation, editor session token, and recording camera identity.

#### Scenario: Timeline state listener opens another project
- **WHEN** begin, resume, or pause emits a synchronous state event whose listener opens project B
- **THEN** project B remains authoritative, the recorder is inactive, the controller is paused, and React reports neither recording nor playing

### Requirement: Camera drive obeys modal and Studio-instance boundaries
Camera drive SHALL accept keyboard input only for its owning Studio instance, SHALL ignore prevented events, and SHALL clear held input and smoothed motion while overwrite confirmation is pending.

#### Scenario: Overwrite confirmation opens during camera motion
- **WHEN** a camera with disabled recorded tracks is moving and overwrite confirmation opens
- **THEN** motion stops and W/A/S/D, arrows, Q/E, brackets, and modifier drive keys cannot change its pose behind the modal

#### Scenario: Two Studio instances select cameras
- **WHEN** a drive key originates inside Studio A
- **THEN** only Studio A's camera moves and Studio B's camera and recording remain unchanged

### Requirement: Long recording simplification is stack-safe
Sample simplification SHALL preserve RDP deviation semantics and chronological output without recursion proportional to sample count.

#### Scenario: Adversarial 8,000-point recording
- **WHEN** an alternating 8,000-point position path is simplified with default tolerance
- **THEN** simplification completes without call-stack failure and preserves the first point, last point, and ascending order

### Requirement: Timeline imports are bounded before deep validation
Project package parsing SHALL enforce explicit maximum track count, shot count, per-track keyframes, and total keyframes immediately after migration and before hierarchy, asset, schema, or structure traversal.

#### Scenario: Any timeline budget is exceeded
- **WHEN** migrated timeline arrays exceed a configured cardinality limit
- **THEN** parsing returns `too-large` with the observed and allowed count even if entries after the boundary are structurally invalid

### Requirement: Timeline reference and reorder validation are linear
Timeline validation SHALL index objects by id once for track and shot references. Shot reorder membership SHALL use a current-id Set rather than scanning the current id array for each requested id.

#### Scenario: Large valid timeline is validated and reordered
- **WHEN** many tracks/shots reference existing objects and a complete shot permutation is submitted
- **THEN** reference and membership checks perform linear indexed lookups and preserve existing validation and atomic reorder behavior
