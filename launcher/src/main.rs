#![windows_subsystem = "windows"]

mod autostart;
mod icon;
mod paths;
mod runtime;
mod supervisor;

use icon::Tone;
use std::fs;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::ptr::null;
use supervisor::{Status, Supervisor};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{TrayIcon, TrayIconBuilder};
use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
use windows_sys::Win32::System::Threading::CreateMutexW;

const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
const SERVER_URL: &str = "http://127.0.0.1:8787";

enum UserEvent {
    Menu(MenuEvent),
    Status(Status),
}

fn acquire_single_instance() -> bool {
    let name: Vec<u16> = "Local\\AntigravityProviderTray\0".encode_utf16().collect();
    unsafe {
        let handle = CreateMutexW(null(), 0, name.as_ptr());
        !handle.is_null() && GetLastError() != ERROR_ALREADY_EXISTS
    }
}

fn enable_autostart_on_first_run() {
    let marker = paths::data_dir().join("launcher-initialized");
    if marker.exists() {
        autostart::refresh_if_enabled();
        return;
    }
    if autostart::set(true).is_ok() {
        let _ = fs::create_dir_all(paths::data_dir());
        let _ = fs::write(marker, "");
    }
}

fn log_launcher_error(message: &str) {
    use std::io::Write;
    let path = paths::log_path();
    let _ = fs::create_dir_all(paths::data_dir());
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "--- launcher: {message} ---");
    }
}

fn open_login_console() {
    let (Some(root), Some(node)) = (paths::project_root(), paths::node_exe()) else {
        return;
    };
    let _ = Command::new("cmd.exe")
        .current_dir(root)
        .raw_arg(format!("/c \"\"{}\" src\\cli.js login & pause\"", node.display()))
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn();
}

fn open_log() {
    let _ = Command::new("notepad.exe").arg(paths::log_path()).spawn();
}

fn present(status: &Status) -> (Tone, String, String) {
    match status {
        Status::Running => (
            Tone::Running,
            format!("Running - {SERVER_URL}"),
            format!("Antigravity server running ({SERVER_URL})"),
        ),
        Status::Stopped => (Tone::Stopped, "Stopped".to_string(), "Antigravity server stopped".to_string()),
        Status::Waiting(note) => (Tone::Waiting, note.clone(), format!("Antigravity server: {note}")),
    }
}

fn main() {
    if !acquire_single_instance() {
        return;
    }
    enable_autostart_on_first_run();
    match runtime::prepare() {
        Ok(Some(dir)) => paths::set_runtime(dir),
        Ok(None) => {}
        Err(error) => log_launcher_error(&format!("Cannot unpack runtime: {error}")),
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();

    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu_proxy.send_event(UserEvent::Menu(event));
    }));

    let status_proxy = event_loop.create_proxy();
    let supervisor = Supervisor::start(move |status| {
        let _ = status_proxy.send_event(UserEvent::Status(status));
    });

    let status_item = MenuItem::new("Starting", false, None);
    let toggle_item = MenuItem::new("Stop server", true, None);
    let restart_item = MenuItem::new("Restart server", true, None);
    let login_item = MenuItem::new("Login...", true, None);
    let log_item = MenuItem::new("Open log", true, None);
    let autostart_item = CheckMenuItem::new("Run at Windows startup", true, autostart::is_enabled(), None);
    let quit_item = MenuItem::new("Quit", true, None);

    let menu = Menu::new();
    menu.append_items(&[
        &status_item,
        &PredefinedMenuItem::separator(),
        &toggle_item,
        &restart_item,
        &login_item,
        &log_item,
        &PredefinedMenuItem::separator(),
        &autostart_item,
        &PredefinedMenuItem::separator(),
        &quit_item,
    ])
    .expect("menu items are valid");

    let mut tray: Option<TrayIcon> = None;
    let mut menu = Some(menu);

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                tray = TrayIconBuilder::new()
                    .with_menu(Box::new(menu.take().expect("menu built once")))
                    .with_tooltip("Antigravity server")
                    .with_icon(icon::make(Tone::Waiting))
                    .build()
                    .ok();
            }
            Event::UserEvent(UserEvent::Status(status)) => {
                let (tone, text, tooltip) = present(&status);
                status_item.set_text(text);
                toggle_item.set_text(if supervisor.is_wanted() { "Stop server" } else { "Start server" });
                if let Some(tray) = &tray {
                    let _ = tray.set_icon(Some(icon::make(tone)));
                    let _ = tray.set_tooltip(Some(tooltip));
                }
            }
            Event::UserEvent(UserEvent::Menu(event)) => {
                if event.id == toggle_item.id() {
                    let wanted = !supervisor.is_wanted();
                    supervisor.set_wanted(wanted);
                    toggle_item.set_text(if wanted { "Stop server" } else { "Start server" });
                } else if event.id == restart_item.id() {
                    supervisor.restart();
                    toggle_item.set_text("Stop server");
                } else if event.id == login_item.id() {
                    open_login_console();
                } else if event.id == log_item.id() {
                    open_log();
                } else if event.id == autostart_item.id() {
                    if autostart::set(autostart_item.is_checked()).is_err() {
                        autostart_item.set_checked(autostart::is_enabled());
                    }
                } else if event.id == quit_item.id() {
                    supervisor.shutdown();
                    tray.take();
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}
