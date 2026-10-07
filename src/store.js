/**
 * Credential file shared by Windows and Linux.
 * Default location is ~/.antigravity-provider/credentials.json.
 * Tokens stay in that file; the CLI prints only the account and the path.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** @returns {string} */
export function defaultCredentialPath() {
	return path.join(os.homedir(), ".antigravity-provider", "credentials.json");
}

/**
 * Atomic JSON write with mode 0600. Callers share this so credential, account,
 * session, and API-key files cannot tear on a crash.
 * @param {string} file
 * @param {object} data
 */
export function writeJsonAtomic(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const json = `${JSON.stringify(data, null, 2)}\n`;
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// chmod is not meaningful on every Windows filesystem. The file is still written.
	}
	return file;
}

/**
 * @param {object} credential
 * @param {string} [file]
 */
export function saveCredentials(credential, file = defaultCredentialPath()) {
	return writeJsonAtomic(file, credential);
}

/**
 * @param {string} [file]
 */
export function loadCredentials(file = defaultCredentialPath()) {
	const text = fs.readFileSync(file, "utf8");
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || typeof parsed.refresh !== "string" || !parsed.refresh) {
		throw new Error(`Credential file is missing a refresh token: ${file}`);
	}
	return parsed;
}
