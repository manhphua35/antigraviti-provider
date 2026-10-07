/**
 * Multi-account management and auto-quota rotation for Antigravity accounts.
 *
 * Each Gmail account is saved to its own file in ~/.antigravity-provider/accounts/<email>.json.
 * The active account is kept in sync with ~/.antigravity-provider/credentials.json for 100%
 * backward compatibility.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCredentialPath, loadCredentials, saveCredentials } from "./store.js";

/** Default directory for individual account credential files */
export function defaultAccountsDir() {
	return path.join(os.homedir(), ".antigravity-provider", "accounts");
}

/** Default path for the multi-account index file */
export function defaultAccountsIndexPath() {
	return path.join(os.homedir(), ".antigravity-provider", "accounts.json");
}

/**
 * Sanitize an email address into a safe filename.
 * @param {string} email
 */
export function accountFileName(email) {
	const safe = String(email).trim().toLowerCase().replace(/[/\\?%*:|"<>]/g, "_");
	return `${safe}.json`;
}

/**
 * Get the full path to an individual account's credentials file.
 * @param {string} email
 * @param {string} [accountsDir]
 */
export function accountFilePath(email, accountsDir = defaultAccountsDir()) {
	return path.join(accountsDir, accountFileName(email));
}

/**
 * Atomic JSON file write with 0600 permissions.
 * @param {string} file
 * @param {object} data
 */
function writeJsonAtomic(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const json = `${JSON.stringify(data, null, 2)}\n`;
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// chmod may not apply on all Windows filesystems
	}
}

/**
 * Load the multi-account index.
 * Automatically scans accountsDir and imports existing credentials.json if present.
 * @param {{
 *   indexPath?: string,
 *   accountsDir?: string,
 *   credentialPath?: string,
 * }} [options]
 * @returns {{ active: string | null, accounts: Record<string, any> }}
 */
export function loadAccountsIndex(options = {}) {
	const indexPath = options.indexPath ?? defaultAccountsIndexPath();
	const accountsDir = options.accountsDir ?? defaultAccountsDir();
	const credentialPath = options.credentialPath ?? defaultCredentialPath();

	/** @type {{ active: string | null, accounts: Record<string, any> }} */
	let index = { active: null, accounts: {} };

	if (fs.existsSync(indexPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
			if (parsed && typeof parsed === "object") {
				index = {
					active: typeof parsed.active === "string" ? parsed.active : null,
					accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {},
				};
			}
		} catch {
			// Corrupt index will be rebuilt from files below
		}
	}

	let modified = false;

	// Scan accounts directory for any standalone account files not yet in index
	if (fs.existsSync(accountsDir)) {
		try {
			const files = fs.readdirSync(accountsDir);
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const fullPath = path.join(accountsDir, file);
				try {
					const cred = JSON.parse(fs.readFileSync(fullPath, "utf8"));
					if (cred?.email && !index.accounts[cred.email]) {
						index.accounts[cred.email] = {
							email: cred.email,
							projectId: cred.projectId,
							file: fullPath,
							expires: cred.expires,
							quotaStatus: "ok",
							lastQuotaExhausted: null,
							updatedAt: cred.authorizedAt ?? Date.now(),
						};
						modified = true;
					}
				} catch {
					// Skip unreadable file
				}
			}
		} catch {
			// Directory read error
		}
	}

	// If credentials.json exists and not yet in accounts, import it
	if (fs.existsSync(credentialPath)) {
		try {
			const cred = loadCredentials(credentialPath);
			if (cred?.email) {
				const accFile = accountFilePath(cred.email, accountsDir);
				if (!fs.existsSync(accFile)) {
					saveCredentials(cred, accFile);
				}
				if (!index.accounts[cred.email]) {
					index.accounts[cred.email] = {
						email: cred.email,
						projectId: cred.projectId,
						file: accFile,
						expires: cred.expires,
						quotaStatus: "ok",
						lastQuotaExhausted: null,
						updatedAt: cred.authorizedAt ?? Date.now(),
					};
					modified = true;
				}
				if (!index.active) {
					index.active = cred.email;
					modified = true;
				}
			}
		} catch {
			// Skip unreadable credentials.json
		}
	}

	// Validate active email still exists
	if (index.active && !index.accounts[index.active]) {
		const remaining = Object.keys(index.accounts);
		index.active = remaining[0] ?? null;
		modified = true;
	}

	if (modified) {
		try {
			saveAccountsIndex(index, indexPath);
		} catch {
			// Best-effort index update
		}
	}

	return index;
}

/**
 * Save the multi-account index file.
 * @param {{ active: string | null, accounts: Record<string, any> }} index
 * @param {string} [indexPath]
 */
export function saveAccountsIndex(index, indexPath = defaultAccountsIndexPath()) {
	writeJsonAtomic(indexPath, index);
	return indexPath;
}

/**
 * Upsert an account after login.
 * Saves to accounts/<email>.json, updates accounts.json, and syncs active credentials.json.
 * @param {object} credential
 * @param {{
 *   indexPath?: string,
 *   accountsDir?: string,
 *   credentialPath?: string,
 *   setActive?: boolean,
 * }} [options]
 * @returns {{
 *   email: string,
 *   file: string,
 *   isNewAccount: boolean,
 *   previousActive: string | null,
 *   active: string | null,
 * }}
 */
export function upsertAccount(credential, options = {}) {
	const email = credential.email;
	if (!email) {
		throw new Error("Cannot store account without an email address");
	}

	const accountsDir = options.accountsDir ?? defaultAccountsDir();
	const indexPath = options.indexPath ?? defaultAccountsIndexPath();
	const credentialPath = options.credentialPath ?? defaultCredentialPath();
	const setActive = options.setActive !== false;

	const index = loadAccountsIndex({ indexPath, accountsDir, credentialPath });
	const previousActive = index.active;
	const isNewAccount = !index.accounts[email];

	// Save individual account file
	const targetFile = accountFilePath(email, accountsDir);
	saveCredentials(credential, targetFile);

	// Update record in index
	index.accounts[email] = {
		email,
		projectId: credential.projectId,
		file: targetFile,
		expires: credential.expires,
		quotaStatus: index.accounts[email]?.quotaStatus ?? "ok",
		lastQuotaExhausted: index.accounts[email]?.lastQuotaExhausted ?? null,
		updatedAt: Date.now(),
	};

	if (setActive) {
		index.active = email;
		saveCredentials(credential, credentialPath);
	}

	saveAccountsIndex(index, indexPath);

	return {
		email,
		file: targetFile,
		isNewAccount,
		previousActive,
		active: index.active,
	};
}

/** Default rolling quota recovery cooldown window: 5 hours */
export const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 60 * 60 * 1000;

/**
 * Check if an account is currently in a quota exhaustion state.
 * If the 5-hour cooldown has elapsed, the account is considered recovered.
 * @param {object} account
 * @param {number} [now]
 * @param {number} [cooldownMs]
 */
export function isAccountQuotaExhausted(account, now = Date.now(), cooldownMs = DEFAULT_QUOTA_COOLDOWN_MS) {
	if (account.quotaStatus !== "exhausted") return false;
	if (!account.lastQuotaExhausted) return false;
	const elapsed = now - account.lastQuotaExhausted;
	return elapsed < cooldownMs;
}

/**
 * List all registered accounts with status details.
 * @param {{
 *   indexPath?: string,
 *   accountsDir?: string,
 *   credentialPath?: string,
 *   now?: number,
 * }} [options]
 */
export function listAccounts(options = {}) {
	const now = options.now ?? Date.now();
	const index = loadAccountsIndex(options);
	return Object.values(index.accounts).map((account) => {
		const isExpired = typeof account.expires === "number" && account.expires <= now;
		const isActive = account.email === index.active;
		const isExhausted = isAccountQuotaExhausted(account, now);
		return {
			...account,
			isActive,
			isExpired,
			quotaStatus: isExhausted ? "exhausted" : "ok",
		};
	});
}

/**
 * Switch the active account and sync credentials.json.
 * @param {string} email
 * @param {{
 *   indexPath?: string,
 *   accountsDir?: string,
 *   credentialPath?: string,
 * }} [options]
 */
export function switchActiveAccount(email, options = {}) {
	const index = loadAccountsIndex(options);
	const targetEmail = Object.keys(index.accounts).find((k) => k.toLowerCase() === email.toLowerCase());
	if (!targetEmail || !index.accounts[targetEmail]) {
		const available = Object.keys(index.accounts).join(", ");
		throw new Error(`Account "${email}" not found.${available ? ` Available: ${available}` : " No accounts registered."}`);
	}

	const account = index.accounts[targetEmail];
	const accountFile = account.file ?? accountFilePath(targetEmail, options.accountsDir ?? defaultAccountsDir());
	const credential = loadCredentials(accountFile);

	if (!isAccountQuotaExhausted(account, options.now ?? Date.now())) {
		account.quotaStatus = "ok";
		account.lastQuotaExhausted = null;
	}

	index.active = targetEmail;
	saveAccountsIndex(index, options.indexPath ?? defaultAccountsIndexPath());

	const credentialPath = options.credentialPath ?? defaultCredentialPath();
	saveCredentials(credential, credentialPath);

	return {
		email: targetEmail,
		file: accountFile,
		credential,
	};
}

/**
 * Remove an account from index and delete its dedicated file.
 * @param {string} email
 * @param {{
 *   indexPath?: string,
 *   accountsDir?: string,
 *   credentialPath?: string,
 * }} [options]
 */
export function removeAccount(email, options = {}) {
	const index = loadAccountsIndex(options);
	const targetEmail = Object.keys(index.accounts).find((k) => k.toLowerCase() === email.toLowerCase());
	if (!targetEmail) {
		throw new Error(`Account "${email}" not found.`);
	}

	const account = index.accounts[targetEmail];
	const accountFile = account.file ?? accountFilePath(targetEmail, options.accountsDir ?? defaultAccountsDir());

	if (fs.existsSync(accountFile)) {
		try {
			fs.rmSync(accountFile, { force: true });
		} catch {
			// Best effort remove
		}
	}

	delete index.accounts[targetEmail];

	let nextActive = index.active;
	if (index.active === targetEmail) {
		const remaining = Object.keys(index.accounts);
		nextActive = remaining[0] ?? null;
		index.active = nextActive;
		if (nextActive && index.accounts[nextActive]) {
			try {
				const nextFile = index.accounts[nextActive].file ?? accountFilePath(nextActive, options.accountsDir ?? defaultAccountsDir());
				const cred = loadCredentials(nextFile);
				saveCredentials(cred, options.credentialPath ?? defaultCredentialPath());
			} catch {
				// Failed to sync next
			}
		}
	}

	saveAccountsIndex(index, options.indexPath ?? defaultAccountsIndexPath());

	return {
		removed: targetEmail,
		active: nextActive,
	};
}

/**
 * Detect whether an error corresponds to quota / rate limit exhaustion
 * (5-hour limit, weekly limit, HTTP 429, RESOURCE_EXHAUSTED).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isQuotaError(error) {
	if (!error) return false;
	const status = typeof error === "object" && error !== null && "status" in error ? /** @type {any} */ (error).status : undefined;
	if (status === 429) return true;

	const msg = String(error instanceof Error ? error.message : error).toLowerCase();
	return (
		msg.includes("429") ||
		msg.includes("resource_exhausted") ||
		msg.includes("quota_exceeded") ||
		msg.includes("quota exceeded") ||
		msg.includes("rate limit") ||
		msg.includes("ratelimit") ||
		msg.includes("limit reached") ||
		msg.includes("limit exceeded") ||
		msg.includes("too many requests") ||
		msg.includes("free tier limit") ||
		msg.includes("user has reached the limit")
	);
}

/**
 * Mark an account as having exhausted its quota.
 * @param {string} email
 * @param {{
 *   indexPath?: string,
 *   accountsDir?: string,
 *   credentialPath?: string,
 * }} [options]
 */
export function markQuotaExhausted(email, options = {}) {
	const index = loadAccountsIndex(options);
	const targetEmail = Object.keys(index.accounts).find((k) => k.toLowerCase() === email.toLowerCase());
	if (!targetEmail || !index.accounts[targetEmail]) return;

	index.accounts[targetEmail].quotaStatus = "exhausted";
	index.accounts[targetEmail].lastQuotaExhausted = Date.now();
	saveAccountsIndex(index, options.indexPath ?? defaultAccountsIndexPath());
}

/**
 * Reset quota status to "ok" for an account (or all accounts).
 * @param {string} [email]
 * @param {{
 *   indexPath?: string,
 *   accountsDir?: string,
 *   credentialPath?: string,
 * }} [options]
 */
export function resetAccountQuota(email, options = {}) {
	const index = loadAccountsIndex(options);
	let count = 0;
	if (!email || email === "all") {
		for (const acc of Object.values(index.accounts)) {
			acc.quotaStatus = "ok";
			acc.lastQuotaExhausted = null;
			count += 1;
		}
	} else {
		const targetEmail = Object.keys(index.accounts).find((k) => k.toLowerCase() === email.toLowerCase());
		if (targetEmail && index.accounts[targetEmail]) {
			index.accounts[targetEmail].quotaStatus = "ok";
			index.accounts[targetEmail].lastQuotaExhausted = null;
			count = 1;
		}
	}
	saveAccountsIndex(index, options.indexPath ?? defaultAccountsIndexPath());
	return count;
}

/**
 * Rotate to the next available account when the current one hits its quota limit.
 * Prefers accounts with quotaStatus === "ok", or the one with the oldest lastQuotaExhausted.
 * @param {string | undefined | null} currentEmail
 * @param {{
 *   indexPath?: string,
 *   accountsDir?: string,
 *   credentialPath?: string,
 * }} [options]
 * @returns {{
 *   rotated: boolean,
 *   previousEmail: string | null,
 *   newEmail?: string,
 *   credential?: object,
 * }}
 */
export function rotateToNextAvailableAccount(currentEmail, options = {}) {
	const index = loadAccountsIndex(options);
	const accounts = Object.values(index.accounts);
	if (accounts.length <= 1) {
		return { rotated: false, previousEmail: currentEmail ?? null };
	}

	const candidates = accounts.filter(
		(a) => !currentEmail || a.email.toLowerCase() !== currentEmail.toLowerCase(),
	);
	if (candidates.length === 0) {
		return { rotated: false, previousEmail: currentEmail ?? null };
	}

	const now = options.now ?? Date.now();
	// 1. Look for candidate that is NOT exhausted (or whose cooldown has elapsed)
	let next = candidates.find((a) => !isAccountQuotaExhausted(a, now));

	// 2. If all candidates are marked exhausted, pick the one with oldest lastQuotaExhausted
	if (!next) {
		next = [...candidates].sort((a, b) => {
			const timeA = a.lastQuotaExhausted ?? 0;
			const timeB = b.lastQuotaExhausted ?? 0;
			return timeA - timeB;
		})[0];
	}

	if (!next) {
		return { rotated: false, previousEmail: currentEmail ?? null };
	}

	const switched = switchActiveAccount(next.email, options);
	return {
		rotated: true,
		previousEmail: currentEmail ?? null,
		newEmail: next.email,
		credential: switched.credential,
	};
}
