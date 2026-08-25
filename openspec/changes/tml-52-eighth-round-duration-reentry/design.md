## Context

The project callback freshness runner can validate only before and after a complete controller call. setDuration() itself contains a synchronous event boundary: it writes duration, calls seek(), and then may pause and emit settings. If seek() re-enters setDuration(), the outer call needs controller-owned freshness to know that its captured next value is obsolete.

## Goals / Non-Goals

**Goals:**

- Preserve the nested duration, playing state, and settings snapshot when time:changed synchronously triggers a newer duration operation.
- Prevent the superseded outer setDuration() from pausing or emitting settings after nested completion.
- Cover the production path through SceneEditor, useTimelineSession, shot deletion, and nested shot creation.

**Non-Goals:**

- Building an injected re-entry matrix for the null, session-switch, and deleted-recording-camera branches.
- Reworking the real WebGL test to share Three's module instance or adding bridge-level non-square aspect coverage.
- Adding a dedicated in-flight thumbnail-cancellation retry-budget regression.
- Extending portal theme inheritance to host-provided custom className scopes.

## Decisions

1. TimelineController will maintain a monotonic duration operation generation. A non-noop setDuration() captures the generation after incrementing it.

2. When setDuration() calls seek(), it will compare the captured generation immediately after seek() returns. A nested non-noop duration change increments the generation; a mismatch terminates the outer call before the next===0 pause and before emitSettings().

3. Equal-duration no-ops will not increment the generation because they do not supersede state or emit events.

4. The regression will open a project containing one 10-second shot, play at t=5, delete the shot, and add an 8-second shot from the resulting time:changed(0). It will assert the editor remains in the same session, controller and React duration equal 8, playing remains true, and only the nested settings snapshot is emitted.

## Risks / Trade-offs

- [Generation is confused with playback state generation] -> Use a dedicated durationOperationGeneration field with a narrow purpose.
- [Nested no-op setDuration suppresses the outer call unnecessarily] -> No-op calls do not increment, so only a real duration mutation supersedes the outer operation.
- [The test accidentally exercises mocks] -> Use the real SceneEditor, TimelineController, hook, deleteShot(), and addShot() methods.

## Migration Plan

No migration or API change is required. The controller fix and real hook regression ship in the same PR head.

## Open Questions

None for this review round.
