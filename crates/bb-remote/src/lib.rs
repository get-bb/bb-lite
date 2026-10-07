pub mod cli_proxy;
pub mod client;
pub mod daemon;
pub mod link;
pub mod outbox;
pub mod protocol;
pub mod serve;
pub mod socket;

pub use cli_proxy::{CliProxy, CliProxyOptions, start_cli_proxy};
pub use client::{RemoteRunner, connect_remote_runner};
pub use daemon::{
    Credentials, JoinOptions, LocalFactory, LocalParts, LocalSetup, RunOptions, RunningRunner,
    join_server, run_runner,
};
pub use link::{Link, link_frames};
pub use outbox::Outbox;
pub use protocol::{Frame, FrameDecoder, Hello, WireError, encode_frame};
pub use serve::{RunnerServing, serve_runner};
pub use socket::{Received, SocketRecv, SocketSend, WireSocket, memory_pair};
