## Why

The fifth review found four deterministic counterexamples that remain invisible to the green gate suite. Synchronous nested project opens can leave runtime consumers on different projects, offscreen capture does not preserve a non-default target's cube face or mip level, endpoint time delivery can finish with a stale payload, and thumbnail retries can exceed their documented per-shot budget.

## What Changes

- Treat project snapshots as latest-wins state across the editor, React mirror, runtime host, and persistence facade.
- Preserve default-framebuffer state separately from non-default render-target state, including cube face and mip level.
- Treat timeline time events as latest-wins state under synchronous listener re-entry.
- Persist thumbnail attempt counts by generation and shot so successful siblings cannot reset a failed shot's budget.
- Add runtime, unit, and real-browser WebGL counterexamples for the four review findings.

## Capabilities

### New Capabilities

- `timeline-review-convergence`: Defines cross-runtime project convergence, exact render-target restoration, latest-wins endpoint time delivery, and per-shot retry limits.

### Modified Capabilities

None.

## Impact

Affected areas are `SceneEditor`, Studio project consumers, `TimelineController`, `TimelinePanel`, offscreen frame capture, and their focused tests. The public `className` portal-theme risk is explicitly outside this round.
