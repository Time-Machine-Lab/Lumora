## Context

The relevant event emitters already support opt-in latest-wins generations, but project and time events do not consistently use them. The current capture helper also reads default framebuffer viewport/scissor state while a non-default target may be active, then restores those defaults onto the target and drops its face/mip selection. Thumbnail retry loops keep no durable per-generation attempt ledger.

## Goals / Non-Goals

**Goals:**

- Make every runtime project mirror converge on the editor's final project after synchronous B-to-C re-entry.
- Restore default framebuffer state and the previously active render target, cube face, mip level, and target-local viewport/scissor exactly.
- Prevent later time listeners from receiving an outer endpoint after a nested restart has emitted time zero.
- Enforce at most three capture attempts per shot and generation even when sibling successes rerender the panel.

**Non-Goals:**

- Extending portal theming to host-provided custom `className` scopes.
- Changing project schemas, timeline interpolation, or capture image dimensions.

## Decisions

1. `SceneEditor` will emit `project:changed` with latest-wins semantics. State consumers will still validate the payload token/reference before applying it, and persistence will revalidate after `autosaver.changed()` because that call can synchronously notify external listeners.

2. Offscreen capture will configure viewport/scissor on its temporary render target instead of mutating renderer defaults. Restoration will bind the default framebuffer, restore its saved viewport/scissor/test state, then rebind the previous target with its saved active cube face and mip level. Target-local state is restored by `setRenderTarget` itself.

3. `TimelineController.emitTime()` will opt into the emitter's latest-wins generation. This uses the same established mechanism as state events and avoids a second bespoke controller generation.

4. `TimelinePanel` will retain a generation-scoped attempt map keyed by shot id. Attempts increment before capture and are cleared only when the thumbnail generation changes.

5. The WebGL acceptance test will dynamically import the real capture module through the existing Vite test server, render vertically distinct colors with a real `WebGLRenderer`, and verify both PNG orientation and non-default cube-target state on success and throw paths.

## Risks / Trade-offs

- [A stale consumer bypasses validation] -> Project delivery itself is latest-wins, while internal consumers also validate ownership at their update boundary.
- [Temporary target restoration triggers framebuffer work] -> Captures are low-frequency thumbnail operations and correctness takes priority over one extra default-framebuffer bind.
- [Attempt ledger grows] -> It is cleared atomically on every generation change and contains at most one entry per shot.

## Migration Plan

No data migration is required. Source and regression tests ship together in the sixth-round PR head.

## Open Questions

None for this review round.
