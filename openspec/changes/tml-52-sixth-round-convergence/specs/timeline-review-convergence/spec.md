## ADDED Requirements

### Requirement: Project state delivery converges after synchronous re-entry
Project snapshots SHALL use latest-wins delivery, and internal runtime consumers MUST reject a payload that no longer belongs to the editor's current session and project.

#### Scenario: Persistence state listener opens project C while project B is delivered
- **WHEN** handling project B synchronously notifies a listener that opens project C
- **THEN** the editor, React scene mirror, plugin host, host event subscribers, and persistence facade all finish on project C

### Requirement: Offscreen capture preserves every active target state
Bound-camera capture SHALL preserve default framebuffer state separately from the active render target and SHALL restore the target's cube face, mip level, viewport, scissor, and scissor-test state after success or failure.

#### Scenario: Capture begins with a non-default cube target
- **WHEN** capture succeeds while a cube target face and nonzero mip level are active
- **THEN** the PNG contains correctly oriented real WebGL pixels and every renderer state value equals its pre-capture value

#### Scenario: Rendering throws with a non-default cube target
- **WHEN** capture rendering throws
- **THEN** capture returns null and the same target, face, mip, viewport, scissor, and default framebuffer state are restored

### Requirement: Time state delivery is latest-wins
Timeline time events SHALL stop delivering an outer payload after a synchronous nested time event supersedes it.

#### Scenario: First endpoint listener restarts before the second listener
- **WHEN** the first `time:changed` endpoint listener calls `play()` and emits time zero
- **THEN** the second listener's final and only nested payload equals the controller's actual zero time

### Requirement: Thumbnail retries are bounded per shot and generation
Each shot SHALL receive no more than three capture attempts in one thumbnail generation, independent of successful sibling updates.

#### Scenario: One shot always fails while siblings succeed
- **WHEN** successful sibling thumbnails rerender the panel in the same generation
- **THEN** the failing shot receives exactly three total attempts and can retry only after the generation changes
