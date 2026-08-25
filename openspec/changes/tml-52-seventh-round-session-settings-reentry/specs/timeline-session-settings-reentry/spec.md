## ADDED Requirements

### Requirement: Timeline project synchronization rejects superseded payloads
The timeline session project consumer SHALL validate that its project and session payload still belong to the editor immediately before and after every synchronous controller operation that can publish events. Once a nested project change supersedes the payload, the outer callback MUST NOT write session identity or apply additional values derived from that payload.

#### Scenario: Applying project B fps synchronously opens project C
- **WHEN** the timeline session handles project B and a settings listener synchronously opens project C from B's setFps()
- **THEN** the editor project, controller fps/duration, hook state fps/duration, and observed session identity all finish on project C

#### Scenario: Re-entry occurs in any project callback branch
- **WHEN** a synchronous controller event supersedes the payload while handling null, a session switch, an ordinary edit, or removal of the recording camera
- **THEN** that callback stops before its next payload-derived write or controller operation

### Requirement: Settings state delivery is latest-wins
Timeline settings events SHALL stop delivering an outer snapshot after a synchronous nested settings event supersedes it.

#### Scenario: First settings listener updates fps before the second listener
- **WHEN** the first listener handles fps 30 and synchronously changes fps to 60
- **THEN** the second listener receives only fps 60 and its payload equals the controller's current settings
