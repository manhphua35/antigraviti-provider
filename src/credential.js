/**
 * Use the saved login, refreshing the access token when it is inside the
 * Antigravity skew window. The stream itself refuses an already-expired token.
 */
import fs from "node:fs";
import path from "node:path";
import { OAuthError } from "./errors.js";
import { refreshAntigravity } from "./login.js";
import { saveCredentials } from "./store.js";

/** Same skew `shouldRefreshGeminiCliCredentials` uses for Antigravity. */
export const ANTIGRAVITY_REFRESH_SKEW_MS = 60_000;

/**
 * @param {object} credential
 * @param {{
 *   now?: () => number,
 *   fetch?: typeof fetch,
 *   signal?: AbortSignal,
 *   credentialPath?: string,
 *   save?: boolean,
 * }} [options]
 */
export async function ensureFreshCredential(credential, options = {}) {
	if (!credential?.access || !credential?.projectId || !credential?.refresh) {
		throw new OAuthError("Not logged in. Run: node src/cli.js login", { kind: "configuration" });
	}
	const now = options.now?.() ?? Date.now();
	const expiresAt = credential.expires;
	if (typeof expiresAt !== "number" || now + ANTIGRAVITY_REFRESH_SKEW_MS < expiresAt) return credential;
	const refreshed = await refreshAntigravity(credential, { fetch: options.fetch, signal: options.signal });
	const next = { ...credential, ...refreshed };
	if (options.credentialPath && options.save !== false) {
		saveCredentials(next, options.credentialPath);
		if (next.email) {
			try {
				const baseDir = path.dirname(options.credentialPath);
				const safe = String(next.email).trim().toLowerCase().replace(/[/\\?%*:|"<>]/g, "_");
				const accFile = path.join(baseDir, "accounts", `${safe}.json`);
				if (fs.existsSync(accFile)) {
					saveCredentials(next, accFile);
				}
			} catch {
				// Best effort
			}
		}
	}
	return next;
}
