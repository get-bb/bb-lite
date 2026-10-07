//! The "bb connect" tunnel: the binary frame contract shared with the hosted gate and the client
//! session that replays gate streams against a loopback origin.

pub mod contract;
pub mod session;

pub use contract::{
    ContractError, Frame, HeaderPair, OpenHttpFrame, OpenWsFrame, chunk_body, decode_frame,
    encode_frame,
};
pub use session::{
    Heartbeat, ResolveOrigin, ResolvedStreamOrigin, StreamOriginResult, TunnelLog, TunnelMessage,
    TunnelSession, TunnelSessionOptions, TunnelSocket,
};
