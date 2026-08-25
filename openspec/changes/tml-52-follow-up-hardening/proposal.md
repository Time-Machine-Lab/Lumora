## Why

An independent review of merged main commit 93ee788 found one recording-state re-entry blocker and four severe runtime/import risks. Synchronous timeline listeners can leave stale React recording state, camera drive crosses modal and Studio-instance boundaries, recursive simplification overflows on long recordings, and imported timeline data has neither explicit budgets nor consistently linear validation.

## What Changes

- Make begin/resume/pause recording actions reject stale continuation after synchronous timeline events.
- Scope camera-drive keyboard input to the active Studio instance and hard-disable drive while overwrite confirmation is open.
- Make RDP simplification stack-safe for at least 8,000 adversarial samples.
- Add import budgets for tracks, shots, per-track keyframes, and total keyframes before deep validation.
- Replace timeline reference and shot reorder quadratic scans with Map/Set membership.

## Capabilities

### New Capabilities

- timeline-follow-up-hardening: Defines recording-action freshness, drive isolation, long-sample simplification, and bounded linear timeline imports.

### Modified Capabilities

None.

## Impact

Changes are limited to timeline recording/session logic, Studio keyboard routing, camera drive admission, sample simplification, project-package timeline limits, and linear validation/reorder indexes. Existing project files remain schema-compatible.
