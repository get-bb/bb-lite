//! "bb connect": links this bb to a getbb.app account and keeps a tunnel open to its gate.

pub mod account;
pub mod contract;
pub mod hosted;
pub mod tunnel;

pub use account::{AccountOptions, ConnectAccount, Link, LogoutResult, legacy_link, share_url};
pub use contract::{
    CONNECT_RPC_METHODS, ConnectState, ConnectStatus, LoginState, LoginView, PortInput,
    SetEnabledInput, ShareView,
};
pub use hosted::{ConnectError, LinkPoll, LinkStart, Machine, Profile, ProfileReply};
pub use tunnel::{ConfirmRefused, ConnectTunnel, TunnelOptions, TunnelStatus};
