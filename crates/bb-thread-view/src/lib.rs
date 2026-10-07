//! Timeline rows as the `bb` CLI prints them: the port of the parts of `packages/thread-view`
//! behind `bb thread log` (view rows and row titles). Pure functions, no I/O.

pub mod event;
pub mod format;
pub mod rows;
pub mod timeline_row_title;
pub mod timeline_view;
pub mod types;
