## ADDED Requirements

### Requirement: Duration operations reject stale continuation after seek re-entry
TimelineController SHALL treat a nested non-noop duration mutation as superseding an outer duration operation. After an internal seek() publishes time:changed, the outer operation MUST revalidate ownership before applying a zero-duration pause or publishing settings.

#### Scenario: Deleting the only shot synchronously creates a replacement shot
- **WHEN** deleting the only 10-second shot sets duration to zero and the resulting time:changed listener synchronously adds an 8-second replacement shot
- **THEN** the editor remains in the same session, controller and hook duration equal 8, playback remains active, and listeners receive no settings snapshot from the superseded outer operation

#### Scenario: No nested duration mutation occurs
- **WHEN** seek() returns without another non-noop duration operation
- **THEN** the outer setDuration() applies its pause and settings behavior exactly once
