## Why

The sixth review found one remaining deterministic re-entry path: while the timeline session applies project B, setFps() can synchronously open project C. Nested C finishes first, but the outer B callback then continues with B-derived duration and session state. In addition, settings:changed can deliver an outer stale snapshot after the nested C snapshot.

## What Changes

- Revalidate the project/session payload before and after every timeline operation in the project callback that can synchronously emit events.
- Stop the outer project callback immediately when a nested project change supersedes its payload.
- Deliver settings:changed with latest-wins semantics.
- Add a core two-listener settings counterexample and a React hook counterexample where applying B's fps synchronously opens C.

## Capabilities

### New Capabilities

- timeline-session-settings-reentry: Defines project payload freshness across timeline-session synchronization and latest-wins settings delivery.

### Modified Capabilities

None.

## Impact

The code change is limited to TimelineController.emitSettings(), useTimelineSession, and their focused tests. Renderer capture, thumbnail cancellation accounting, and portal theming are not changed.
