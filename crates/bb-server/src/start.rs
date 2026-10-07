use crate::config::ServerEnv;

pub struct RunningServer {}

impl RunningServer {
    pub async fn shutdown(self) {
        todo!()
    }
}

pub async fn start_server(_env: ServerEnv) -> anyhow::Result<RunningServer> {
    todo!()
}
