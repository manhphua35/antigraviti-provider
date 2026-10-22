use std::env;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const MAX_ANCESTORS: usize = 6;

static RUNTIME: OnceLock<PathBuf> = OnceLock::new();

pub fn set_runtime(dir: PathBuf) {
    let _ = RUNTIME.set(dir);
}

pub fn data_dir() -> PathBuf {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".antigravity-provider")
}

pub fn log_path() -> PathBuf {
    data_dir().join("server.log")
}

fn is_project_root(dir: &Path) -> bool {
    dir.join("src").join("cli.js").is_file() && dir.join("package.json").is_file()
}

fn exe_dir() -> Option<PathBuf> {
    env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

pub fn project_root() -> Option<PathBuf> {
    if let Some(value) = env::var_os("ANTIGRAVITY_ROOT") {
        let dir = PathBuf::from(value);
        return is_project_root(&dir).then_some(dir);
    }
    if let Some(runtime) = RUNTIME.get() {
        let bundled = runtime.join("app");
        if is_project_root(&bundled) {
            return Some(bundled);
        }
    }
    let bundled = exe_dir()?.join("app");
    if is_project_root(&bundled) {
        return Some(bundled);
    }
    let exe = env::current_exe().ok()?;
    exe.ancestors()
        .skip(1)
        .take(MAX_ANCESTORS)
        .find(|dir| is_project_root(dir))
        .map(Path::to_path_buf)
}

const MIN_NODE_MAJOR: u32 = 18;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn check_node_version(node: &Path) -> Result<(), String> {
    let output = Command::new(node)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Cannot run {}: {error}", node.display()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.trim();
    let major = version
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .ok_or_else(|| format!("Unrecognised Node version: {version}"))?;
    if major < MIN_NODE_MAJOR {
        return Err(format!("Node {version} is too old. Need Node {MIN_NODE_MAJOR}+"));
    }
    Ok(())
}

pub fn node_exe() -> Option<PathBuf> {
    if let Some(runtime) = RUNTIME.get() {
        let bundled = runtime.join("node").join("node.exe");
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    if let Some(dir) = exe_dir() {
        let bundled = dir.join("node").join("node.exe");
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let candidate = dir.join("node.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|name| env::var_os(name))
        .flat_map(|base| {
            let base = PathBuf::from(base);
            [base.join("nodejs").join("node.exe"), base.join("Programs").join("nodejs").join("node.exe")]
        })
        .find(|candidate| candidate.is_file())
}
