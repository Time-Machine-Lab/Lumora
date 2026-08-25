## Context

Timeline thumbnails are currently keyed only by the editor session and a partial project projection, while GLTF attachment completes later without notifying the panel. Bound-camera capture renders into the visible canvas at host dimensions. Project events and non-looping endpoint handling also read mutable current state after synchronous listeners can re-enter them.

## Goals / Non-Goals

**Goals:**

- Make thumbnail cache entries represent the active scene and the actual render-ready content.
- Keep bound-camera capture at project aspect and isolated from the visible renderer.
- Make project and playback event handling latest-wins under synchronous re-entry.
- Exercise deterministic playback through the real playback loop and preserve modal theme styling through the portal.

**Non-Goals:**

- Changing persisted project schemas, public timeline controls, or interpolation algorithms.
- Introducing a background thumbnail service or a new rendering dependency.

## Decisions

1. `projectContentFingerprint` will include `activeSceneId`, and `EditorViewport` will publish a monotonic render-content generation whenever the scene tree is rebuilt or deferred model content is attached. `TimelinePanel` will include both values in its cache generation. Waiting for all leases was rejected because partial failures could block every thumbnail indefinitely.

2. Thumbnail capture will cache only successful image data URLs. Each missing shot gets a small bounded number of frame-delayed attempts per generation; exhausted failures remain missing until readiness or render generation changes. Caching `null` was rejected because it converts transient WebGL/node failures into permanent placeholders.

3. Bound-camera screenshots will render to a fixed-size `WebGLRenderTarget` whose dimensions match the project aspect, read pixels, vertically flip them into a temporary 2D canvas, and encode PNG. Renderer target, viewport, scissor, clear state, and camera aspect are restored in `finally`. Rendering into the visible canvas and repainting afterward was rejected because it can still flash and couples capture to host layout.

4. `project:changed` will carry the session token captured with its payload. Consumers that combine payload data with current editor state must reject an event whose token is no longer current after a nested open. Comparing only the project reference was rejected as a weaker, implicit ownership contract.

5. At a non-looping endpoint, `TimelineController.tick` will emit time, then re-check whether a listener restarted playback before publishing `playing:false`; it will return the controller's final current time. This keeps nested operations authoritative.

6. The portal overlay will also carry the `lumora-studio` theme scope, while a dedicated portal class neutralizes root layout sizing. This reuses the existing variables instead of duplicating fallback colors.

7. AC1 will perform two independent runs from zero to the same natural non-looping endpoint, with no endpoint seek after playback. Pose values must match exactly and the endpoint canvas must stay within a strict pixel threshold.

## Risks / Trade-offs

- [Repeated GLTF settlements cause multiple recaptures] -> Generation changes are bounded by actual content settlements and the panel serializes captures.
- [Readback and PNG encoding cost] -> Thumbnails use a small fixed maximum dimension and run only for missing keys while playback/recording is idle.
- [Portal theme class inherits root layout rules] -> A portal-specific class explicitly uses fixed overlay layout and auto sizing.
- [Real-time e2e playback can be slower] -> Use natural endpoint completion and state-based waiting instead of sleep-based mid-run comparisons.

## Migration Plan

No data migration is required. Ship the source and tests together; rollback is the single fifth-round commit if a renderer compatibility issue appears.

## Open Questions

None for this review round.
