use crate::paths;
use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::ptr::null;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const HEALTHY_RUNTIME: Duration = Duration::from_secs(10);
const MIN_BACKOFF: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Running,
    Stopped,
    Waiting(String),
}

struct Job(HANDLE);

unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    fn new() -> Option<Job> {
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            (ok != 0).then_some(Job(handle))
        }
    }

    fn adopt(&self, child: &Child) {
        unsafe {
            AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
        }
    }
}

struct Shared {
    wanted: AtomicBool,
    shutdown: AtomicBool,
    restart: AtomicBool,
    child: Mutex<Option<Child>>,
}

#[derive(Clone)]
pub struct Supervisor {
    shared: Arc<Shared>,
}

impl Supervisor {
    pub fn start(on_status: impl Fn(Status) + Send + 'static) -> Supervisor {
        let shared = Arc::new(Shared {
            wanted: AtomicBool::new(true),
            shutdown: AtomicBool::new(false),
            restart: AtomicBool::new(false),
            child: Mutex::new(None),
        });
        let worker = shared.clone();
        thread::spawn(move || run(worker, on_status));
        Supervisor { shared }
    }

    pub fn is_wanted(&self) -> bool {
        self.shared.wanted.load(Ordering::SeqCst)
    }

    pub fn set_wanted(&self, wanted: bool) {
        self.shared.wanted.store(wanted, Ordering::SeqCst);
        if !wanted {
            kill_child(&self.shared);
        }
    }

    pub fn restart(&self) {
        self.shared.wanted.store(true, Ordering::SeqCst);
        self.shared.restart.store(true, Ordering::SeqCst);
        kill_child(&self.shared);
    }

    pub fn shutdown(&self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.wanted.store(false, Ordering::SeqCst);
        kill_child(&self.shared);
    }
}

fn kill_child(shared: &Shared) {
    let mut guard = shared.child.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn open_log() -> Option<File> {
    let path = paths::log_path();
    fs::create_dir_all(path.parent()?).ok()?;
    if fs::metadata(&path).map(|m| m.len() > LOG_ROTATE_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, path.with_extension("log.old"));
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn spawn_server(job: Option<&Job>) -> Result<Child, String> {
    let root = paths::project_root().ok_or("Project folder not found (src/cli.js). Set ANTIGRAVITY_ROOT")?;
    let node = paths::node_exe().ok_or("Node.js not found. Install Node 18+ or add it to PATH")?;
    paths::check_node_version(&node)?;
    let mut log = open_log().ok_or("Cannot open server.log")?;
    let _ = writeln!(log, "--- launcher: starting server ---");
    let stderr = log.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(node)
        .args(["src/cli.js", "serve"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Cannot start node: {e}"))?;
    if let Some(job) = job {
        job.adopt(&child);
    }
    Ok(child)
}

fn run(shared: Arc<Shared>, on_status: impl Fn(Status)) {
    let job = Job::new();
    let mut started_at = Instant::now();
    let mut next_start = Instant::now();
    let mut backoff = MIN_BACKOFF;
    let mut note = String::new();
    let mut last: Option<Status> = None;

    while !shared.shutdown.load(Ordering::SeqCst) {
        {
            let mut guard = shared.child.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(child) = guard.as_mut() {
                if let Ok(Some(exit)) = child.try_wait() {
                    *guard = None;
                    if started_at.elapsed() >= HEALTHY_RUNTIME {
                        backoff = MIN_BACKOFF;
                    }
                    next_start = Instant::now() + backoff;
                    note = format!("Exited ({exit}). Retrying in {}s", backoff.as_secs());
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            } else if shared.restart.swap(false, Ordering::SeqCst) {
                next_start = Instant::now();
                backoff = MIN_BACKOFF;
            }
            if guard.is_none()
                && shared.wanted.load(Ordering::SeqCst)
                && Instant::now() >= next_start
            {
                match spawn_server(job.as_ref()) {
                    Ok(child) => {
                        *guard = Some(child);
                        started_at = Instant::now();
                        note.clear();
                    }
                    Err(message) => {
                        next_start = Instant::now() + backoff;
                        note = format!("{message}. Retrying in {}s", backoff.as_secs());
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                    }
                }
            }
            let status = if guard.is_some() {
                Status::Running
            } else if shared.wanted.load(Ordering::SeqCst) {
                Status::Waiting(if note.is_empty() { "Starting".to_string() } else { note.clone() })
            } else {
                Status::Stopped
            };
            if last.as_ref() != Some(&status) {
                on_status(status.clone());
                last = Some(status);
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
    kill_child(&shared);
}
