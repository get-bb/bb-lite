//! Events to timeline rows: the port of `packages/thread-view`. Pure functions, no I/O.

pub mod build_event_projection;
pub mod build_thread_timeline;
pub mod event;
pub mod format;
pub mod group_turns;
pub mod item_lifecycle;
pub mod operation_projection;
pub mod parse_operation_message;
pub mod rows;
pub mod text_projection;
pub mod thread_state_extraction;
pub mod timeline_row_title;
pub mod timeline_view;
pub mod tool_activity_projection;
pub mod tool_call_parsing;
pub mod types;
pub mod user_message_parsing;
