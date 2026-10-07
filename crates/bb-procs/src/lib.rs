pub mod lines;
pub mod open_targets;
pub mod scripts;
pub mod terminals;

pub use open_targets::{list_open_targets, open_in_target};
pub use scripts::LifecycleScripts;
pub use terminals::Terminals;

fn signal_group(pid: Option<u32>, signal: libc::c_int) -> bool {
    let Some(pid) = pid.and_then(|pid| libc::pid_t::try_from(pid).ok()) else { return false };
    unsafe { libc::kill(-pid, signal) == 0 }
}

fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(text) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    unsafe { libc::access(text.as_ptr(), libc::X_OK) == 0 }
}
