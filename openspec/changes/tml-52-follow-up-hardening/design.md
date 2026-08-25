## Context

Timeline and editor events are synchronous. A recording action can call `timeline.play()` or `timeline.pause()`, whose listeners may open another project before the outer hook callback writes React state. Camera drive separately owns window listeners, so it currently bypasses both the shell's multi-instance keyboard scope and overwrite-modal policy. Core RDP recursion and import validation also accept attacker- or recording-sized arrays without stack or cardinality bounds.

## Goals / Non-Goals

**Goals:**

- Make begin, resume, and pause recording state latest-operation-wins across synchronous timeline event re-entry.
- Stop existing camera momentum and reject new drive keys under overwrite confirmation.
- Ensure one Studio instance cannot drive another instance's camera.
- Simplify an adversarial 8,000-point recording without call-stack failure while preserving RDP semantics and order.
- Reject excessive track/shot/keyframe cardinality before deep schema/asset work and keep timeline reference/reorder checks linear.

**Non-Goals / Follow-up Risks:**

- Fixing ordinary blur -> refocus camera-drive reattachment.
- Changing cross-event FPS/time snapshot semantics.
- Changing `evaluateTrack()` endpoint/Step value aliasing.
- Reworking shot activation and move controls for keyboard/screen-reader accessibility.

## Decisions

1. A hook-owned monotonic generation represents recording command ownership. Every begin/resume/pause action captures the generation, editor session token, and camera id. Any nested recording action or session cancellation increments the generation. React state writes occur only after synchronous timeline calls return and the capture still owns the recorder/session.

2. Studio keyboard scope moves to a small shared module used by shell shortcuts and viewport drive. Multi-instance admission requires the event target inside that Studio root; the single-instance body fallback remains supported. Drive ignores already prevented events.

3. The overwrite modal captures every `DRIVE_KEY_CODES` key. Independently, viewport drive treats `overwritePending` as non-drivable, detaches the target, and clears held input and smoothed velocity.

4. RDP uses an explicit interval stack and retained-index bitmap. It retains the same deviation metric, threshold comparison, endpoints, and source order as the recursive algorithm.

5. `PackageParseLimits` gains four timeline budgets. A shallow post-migration scan checks array lengths and keyframe totals before hierarchy traversal, asset decode, schema validation, or structure validation.

6. Schema cross-references use one object-id Map for both track focal constraints and shot cameras. Shot reorder uses a Set of current ids rather than repeated `Array.includes()`.

## Risks / Trade-offs

- [Operation generation suppresses a valid state write] -> Freshness also checks the captured session/camera, and only nested recording operations or cancellation invalidate the generation.
- [Portal events live outside the Studio root] -> Capture-phase drive-key blocking handles modal controls; `overwritePending` remains the independent motion stop.
- [Iterative RDP changes retained order] -> Mark indexes and emit by ascending source index rather than stack traversal order.
- [Budgets reject formerly accepted extreme projects] -> Publish explicit constants and actionable counts; ordinary exported projects remain far below defaults.

## Migration Plan

No project schema migration is required. New parse-limit fields are optional and default to exported production limits.

## Open Questions

None for this follow-up scope.
