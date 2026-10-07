/**
 * Shared secret for the local chat server.
 * The Google OAuth credential stays on disk. Callers send this key instead.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** @returns {string} */
export function defaultApiKeyPath() {
	return path.join(os.homedir(), ".antigravity-provider", "api-key");
}

/**
 * @param {string} provided
 * @param {string} expected
 */
export function apiKeysMatch(provided, expected) {
	if (!provided || !expected) return false;
	const left = crypto.createHash("sha256").update(provided).digest();
	const right = crypto.createHash("sha256").update(expected).digest();
	return crypto.timingSafeEqual(left, right);
}

/**
 * Flag, then env, then the key file. A missing file is created once.
 * @param {{ key?: string, env?: string, file?: string }} options
 */
export function resolveServerApiKey(options = {}) {
	if (options.key) return { key: options.key, source: "flag", created: false };
	if (options.env) return { key: options.env, source: "env", created: false };
	const file = options.file ?? defaultApiKeyPath();
	if (fs.existsSync(file)) {
		const key = fs.readFileSync(file, "utf8").trim();
		if (key) return { key, source: "file", path: file, created: false };
	}
	const key = crypto.randomBytes(32).toString("base64url");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${key}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// chmod is not meaningful on every Windows filesystem.
	}
	return { key, source: "file", path: file, created: true };
}
