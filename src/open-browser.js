/**
 * Open the authorize URL in the default browser.
 * Windows uses PowerShell Start-Process so `&` in the OAuth query is not parsed
 * by cmd. Linux uses xdg-open, and WSL uses wslview when it is installed.
 * Failure is non-fatal: the caller always prints the URL so it can be copied.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/**
 * @param {string} name
 * @param {NodeJS.Platform} [platform]
 */
export function commandExists(name, platform = process.platform) {
	const checker = platform === "win32" ? "where" : "which";
	const result = spawnSync(checker, [name], { stdio: "ignore", windowsHide: true });
	return result.status === 0;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
export function isWsl(env = process.env, platform = process.platform) {
	if (platform !== "linux") return false;
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
	try {
		return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}

/**
 * @param {string} target
 * @param {{ existsSync?: (path: string) => boolean, env?: NodeJS.ProcessEnv }} [options]
 */
export function windowsOpenerCommand(target, options = {}) {
	const env = options.env ?? process.env;
	const existsSync = options.existsSync ?? fs.existsSync;
	const systemRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || "C:\\Windows";
	const absolute = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const powershell = existsSync(absolute) ? absolute : "powershell.exe";
	const script = `$ErrorActionPreference='Stop';Start-Process '${target.replaceAll("'", "''")}'`;
	return [powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/**
 * Argv used to open `target`, or null when the browser is explicitly disabled.
 * @param {string} target
 * @param {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   isWsl?: boolean,
 *   commandExists?: (name: string) => boolean,
 *   existsSync?: (path: string) => boolean,
 * }} [options]
 * @returns {string[] | null}
 */
export function browserCommand(target, options = {}) {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (env.BROWSER === "0" || env.BROWSER === "none") return null;
	if (env.BROWSER) return [env.BROWSER, target];
	if (platform === "win32") return windowsOpenerCommand(target, { env, existsSync: options.existsSync });
	if (platform === "darwin") return ["open", target];
	const wsl = options.isWsl ?? isWsl(env, platform);
	const exists = options.commandExists ?? ((name) => commandExists(name, platform));
	if (wsl && exists("wslview")) return ["wslview", target];
	return ["xdg-open", target];
}

/**
 * Best-effort browser launch. Never throws.
 * @param {string} target
 * @param {Parameters<typeof browserCommand>[1]} [options]
 */
export function openBrowser(target, options = {}) {
	const cmd = browserCommand(target, options);
	if (!cmd) return;
	try {
		const child = spawn(cmd[0], cmd.slice(1), {
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// The printed URL is the fallback on both Windows and Linux.
	}
}
