## Why

The fourth review exposed eight deterministic counterexamples in timeline session ownership, thumbnail freshness, bound-camera rendering, modal theming, and playback completion. These gaps can leave the UI showing stale or distorted frames, publish contradictory playback state, or let tests pass without exercising the user-visible acceptance path.

## What Changes

- Invalidate shot thumbnails when the active scene or render-ready content changes, and retry transient capture failures without caching them permanently.
- Capture bound cameras at the project aspect ratio without mutating the visible renderer state.
- Ignore stale outer `project:changed` deliveries after a nested project open changes the active session.
- Preserve latest-wins semantics when a `time:changed` listener re-enters playback at the non-looping endpoint.
- Carry Lumora theme variables into the root-level overwrite-confirmation portal.
- Verify deterministic playback using two real runs from the same start to the same natural endpoint and strict pose/frame comparisons.
- Add focused unit and browser regressions for all eight review findings.

## Capabilities

### New Capabilities

- `timeline-review-hardening`: Defines thumbnail freshness, non-invasive bound-camera capture, session event ownership, reentrant playback completion, themed global confirmation, and real deterministic playback acceptance.

### Modified Capabilities

None. The repository has no existing OpenSpec capabilities; this change formalizes existing TML-52 acceptance behavior.

## Impact

Affected areas include `TimelinePanel`, `EditorViewport`, `useTimelineSession`, `TimelineController`, the Studio confirmation portal, their unit tests, and `e2e/timeline.spec.ts`. No public package API or persisted project schema is intentionally changed.
