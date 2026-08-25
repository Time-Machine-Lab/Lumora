## Context

useTimelineSession receives a current project payload and then calls timeline setters. Those setters synchronously publish controller events. A listener can open a newer project during any such call, so entry-only validation is insufficient: the outer callback must not resume applying values derived from the superseded project. Separately, the settings event itself needs the event bus generation behavior already used by project, time, and state snapshots.

## Goals / Non-Goals

**Goals:**

- Keep the editor, controller, hook state, duration, fps, and session identity on project C after B-to-C synchronous re-entry from B's setFps().
- Validate project payload freshness before and after each synchronous event-emitting timeline operation in null, session-change, ordinary-update, and deleted-recording-camera branches.
- Prevent later settings listeners from receiving an outer stale payload after a nested settings update.

**Non-Goals:**

- Reworking the browser WebGL test to share Three's module instance or adding bridge-level non-square aspect coverage.
- Adding a dedicated in-flight thumbnail-cancellation retry-budget regression.
- Extending portal theme inheritance to host-provided custom className scopes.

## Decisions

1. The project callback will define a payload-local isCurrentPayload() check and a small guarded runner. The runner checks immediately before a timeline operation, executes it, and checks immediately after it. Any failed check returns from the outer callback before writing refs or using more payload-derived values.

2. Non-emitting state transitions that precede an emitting operation, including recording cancellation and pending-overwrite cleanup, will also be followed by a freshness check before processing continues. This keeps every callback branch explicit and prevents a future synchronous hook from reopening the same gap.

3. emitSettings() will pass { latestWins: true } to the existing typed event emitter. No controller-specific settings generation will be introduced.

4. Tests will use real TimelineController, SceneEditor, and hook behavior. The hook counterexample will install a settings listener before opening B, open C synchronously on B's fps, and assert the editor, controller, and React mirror all strictly match C.

## Risks / Trade-offs

- [Many guard sites are easy to miss] -> Centralize pre/post checks in a guarded runner and cover the branch with an end-to-end hook-level counterexample.
- [A nested event changes only controller settings, not the project] -> Payload freshness remains true, so the outer project callback continues normally; latest-wins settings delivery still prevents stale listener snapshots.
- [Additional checks add noise] -> Keep the helper local to the callback so ownership and lifetime remain obvious.

## Migration Plan

No data migration or public API change is required. The two focused regressions and implementation ship in the same PR head.

## Open Questions

None for this review round.
