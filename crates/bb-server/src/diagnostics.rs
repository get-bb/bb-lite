//! Memory diagnostics for a running server: what the process holds, how much of it the
//! allocator considers in use, and what each in-memory cache accounts for.

use std::mem::size_of;

use serde_json::{Value, json};

use crate::context::Ctx;
use crate::db::event_read;
use crate::threads::timeline::timeline_reader;

/// The heap a JSON value owns, as an estimate: string and vector capacities plus map entries.
pub fn approx_heap_bytes(value: &Value) -> usize {
    match value {
        Value::String(text) => text.capacity(),
        Value::Array(items) => {
            items.capacity() * size_of::<Value>()
                + items.iter().map(approx_heap_bytes).sum::<usize>()
        }
        Value::Object(fields) => fields
            .iter()
            .map(|(key, field)| {
                size_of::<String>()
                    + size_of::<Value>()
                    + 16
                    + key.capacity()
                    + approx_heap_bytes(field)
            })
            .sum(),
        _ => 0,
    }
}

fn status_field(status: &str, name: &str) -> u64 {
    let line = status.lines().find(|line| line.starts_with(name)).unwrap_or_default();
    let kilobytes = line.split_whitespace().nth(1).and_then(|text| text.parse::<u64>().ok());
    kilobytes.unwrap_or(0) * 1024
}

fn process() -> Value {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let threads = status
        .lines()
        .find_map(|line| line.strip_prefix("Threads:"))
        .and_then(|text| text.trim().parse::<u64>().ok());
    json!({
        "rssBytes": status_field(&status, "VmRSS:"),
        "peakRssBytes": status_field(&status, "VmHWM:"),
        "anonymousBytes": status_field(&status, "RssAnon:"),
        "fileBackedBytes": status_field(&status, "RssFile:"),
        "threads": threads,
    })
}

/// Anonymous writable mappings of at most 64 MiB that hold more than 1 MiB: glibc's per-thread
/// arenas look like this.
fn thread_arenas() -> Value {
    let smaps = std::fs::read_to_string("/proc/self/smaps").unwrap_or_default();
    let (mut count, mut bytes) = (0u64, 0u64);
    let mut candidate = false;
    for line in smaps.lines() {
        let mut parts = line.split_whitespace();
        let first = parts.next().unwrap_or_default();
        if let Some((start, end)) = first.split_once('-')
            && let (Ok(start), Ok(end)) =
                (u64::from_str_radix(start, 16), u64::from_str_radix(end, 16))
        {
            let writable = parts.next().is_some_and(|mode| mode.starts_with("rw"));
            let unnamed = parts.nth(3).is_none();
            candidate = writable && unnamed && end - start <= 64 * 1024 * 1024 + 4096;
        } else if candidate && first == "Rss:" {
            let resident = parts.next().and_then(|text| text.parse::<u64>().ok()).unwrap_or(0);
            if resident > 1024 {
                count += 1;
                bytes += resident * 1024;
            }
            candidate = false;
        }
    }
    json!({ "count": count, "rssBytes": bytes })
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn allocator() -> Value {
    let info = unsafe { libc::mallinfo2() };
    json!({
        "inUseBytes": info.uordblks,
        "freeBytes": info.fordblks,
        "heapBytes": info.arena,
        "mappedBytes": info.hblkhd,
        "releasableTopBytes": info.keepcost,
    })
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn allocator() -> Value {
    Value::Null
}

/// `GET /internal/diagnostics/memory`.
pub fn memory_report(ctx: &Ctx) -> Value {
    json!({
        "process": process(),
        "allocator": allocator(),
        "threadArenas": thread_arenas(),
        "caches": {
            "timelines": timeline_reader(ctx).memory(),
            "events": event_read::cache_memory(&ctx.db),
        },
    })
}

/// `POST /internal/diagnostics/memory/trim`: asks the allocator to return free memory to the
/// system and reports how much the process shrank.
pub fn trim_memory() -> Value {
    let before = process();
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
    let after = process();
    let resident = |report: &Value| report["rssBytes"].as_u64().unwrap_or(0);
    json!({
        "before": before,
        "after": after,
        "releasedBytes": resident(&before).saturating_sub(resident(&after)),
    })
}
