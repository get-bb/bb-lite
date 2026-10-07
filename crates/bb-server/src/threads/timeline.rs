use serde_json::Value;

use crate::context::Ctx;
use crate::db::thread_read::ThreadListRow;
use crate::domain::settings::CompletedTurnDisplay;
use crate::error::ApiResult;
use crate::threads::timeline_pages::TimelinePage;

#[derive(Clone, Debug, PartialEq)]
pub struct TimelineDisplay {
    pub completed_turn_display: CompletedTurnDisplay,
    pub include_diagnostic_operations: bool,
    pub provider_display_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TimelineRequest {
    pub display: TimelineDisplay,
    pub page: TimelinePage,
    pub include_nested_rows: bool,
    pub summary_only: bool,
    pub event_budget: i64,
    pub after_sequence: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnDetailsRequest {
    pub display: TimelineDisplay,
    pub turn_id: String,
    pub source_seq_start: i64,
    pub source_seq_end: i64,
    pub before_cursor: Option<String>,
}

pub async fn read_thread_timeline(
    _ctx: &Ctx,
    _thread: &ThreadListRow,
    _request: TimelineRequest,
) -> ApiResult<Value> {
    todo!()
}

pub async fn read_turn_summary_details(
    _ctx: &Ctx,
    _thread: &ThreadListRow,
    _request: TurnDetailsRequest,
) -> ApiResult<Value> {
    todo!()
}
