use std::path::{Path, PathBuf};
use std::process::Command;

const PLUGINS: [(&str, &str); 5] = [
    ("thread-list", "plugins/thread-list"),
    ("secrets", "plugins/secrets"),
    ("ask-user-question", "plugins/ask-user-question"),
    ("custom-instructions", "plugins/custom-instructions"),
    ("tasks", "plugins/tasks"),
];

fn placeholder(out: &Path, reason: &str) {
    println!("cargo:warning=plugin bundles were not built ({reason}); run pnpm install");
    for (name, _) in PLUGINS {
        let source = "export default () => {\n  throw new Error(\"plugin bundle was not built; run pnpm install\");\n};\n";
        std::fs::write(out.join(format!("{name}.mjs")), source).expect("write placeholder bundle");
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let repo = manifest.join("../..");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("plugin-bundles");
    std::fs::create_dir_all(&out).expect("create bundle directory");
    let script = repo.join("scripts/build-plugin-bundles.mjs");
    println!("cargo:rerun-if-changed={}", script.display());
    println!("cargo:rerun-if-env-changed=BB_NODE_MODULES_ROOT");
    for (_, dir) in PLUGINS {
        println!("cargo:rerun-if-changed={}", repo.join(dir).display());
    }
    for shared in ["packages/plugin/src", "packages/domain/src", "packages/server-contract/src"] {
        println!("cargo:rerun-if-changed={}", repo.join(shared).display());
    }
    match Command::new("node").arg(&script).arg(&out).current_dir(&repo).output() {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let reason = stderr.lines().next().unwrap_or("bundling failed").to_owned();
            placeholder(&out, &reason);
        }
        Err(error) => placeholder(&out, &format!("node is unavailable: {error}")),
    }
}
