use crate::context::Ctx;
use crate::db::hosts::HostRow;
use crate::error::ApiResult;

pub fn require_host(_ctx: &Ctx, _host_id: &str) -> ApiResult<HostRow> {
    todo!("runners/hosts port")
}
