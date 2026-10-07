use axum::Router;

use crate::context::Ctx;

pub fn thread_read_routes() -> Router<Ctx> {
    Router::new()
}
