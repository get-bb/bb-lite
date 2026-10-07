//! The bb server. `docs/architecture.md` describes the behaviour; the module tree mirrors
//! `apps/server/src`.

#![allow(clippy::result_large_err)]

pub mod config;
pub mod context;
pub mod db;
pub mod domain;
pub mod environments;
pub mod error;
pub mod http;
pub mod import_legacy;
pub mod log;
pub mod machine_environment;
pub mod plugins;
pub mod projects;
pub mod providers;
pub mod runners;
pub mod server;
pub mod settings;
pub mod start;
pub mod terminals;
pub mod threads;
pub mod ws;
