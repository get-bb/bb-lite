//! Port of `build-event-projection.ts` (owned by another change; this is a placeholder).

use crate::types::{Projection, ProjectionOptions, ThreadEventWithMeta};

/// `buildEventProjection`.
pub fn build_event_projection(
    events: &[ThreadEventWithMeta],
    options: &ProjectionOptions,
) -> Projection {
    let _ = (events, options);
    todo!("buildEventProjection is ported separately")
}
