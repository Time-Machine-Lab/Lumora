## Why

The seventh review found one remaining internal re-entry gap. TimelineController.setDuration() assigns an outer duration and calls seek(), which synchronously emits time:changed. A listener can create a newer same-session project during that event. The nested project restores its duration and playing state, but the outer setDuration() then resumes and applies its stale next===0 pause and settings emission.

## What Changes

- Track nested duration mutations inside TimelineController.setDuration().
- Stop an outer duration operation immediately after seek() when a nested duration operation supersedes it.
- Add a real useTimelineSession regression that deletes the only shot and synchronously adds a new shot from time:changed.

## Capabilities

### New Capabilities

- timeline-duration-reentry: Defines latest-operation behavior for duration changes that synchronously re-enter through seek/time events.

### Modified Capabilities

None.

## Impact

The implementation is limited to TimelineController.setDuration() and one real hook regression. No project schema, public API, renderer, thumbnail, or portal behavior changes.
