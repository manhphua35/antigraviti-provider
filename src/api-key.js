/**
 * Shared secret and multi-key management for the local chat server.
 * Supports adding, editing, deleting API keys, and tracking request counts
 * and token consumption per key.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./store.js";

/** @param {string} key */
function keyDigest(key) {
	return crypto.createHash("sha256").update(key).digest("hex");
}

/** @returns {string} Default path for the legacy single key file */
export function defaultApiKeyPath() {
	return path.join(os.homedir(), ".antigravity-provider", "api-key");
}

/** @returns {string} Default path for the multi-key store */
export function defaultApiKeysStorePath() {
	return path.join(os.homedir(), ".antigravity-provider", "api-keys.json");
}

/**
 * Timing-safe string comparison.
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
 * The legacy single-key file is imported only for the default store, or when
 * the caller names the file. A temp store must not absorb the home directory key.
 * @param {string} storePath
 * @param {string | undefined} singleKeyFile
 */
function legacyKeyFile(storePath, singleKeyFile) {
	if (singleKeyFile) return singleKeyFile;
	if (storePath === defaultApiKeysStorePath()) return defaultApiKeyPath();
	return undefined;
}

/**
 * @param {{ revoked?: string[] }} store
 * @param {string} key
 */
function isRevoked(store, key) {
	return Array.isArray(store.revoked) && store.revoked.includes(keyDigest(key));
}

/**
 * @param {{ revoked?: string[] }} store
 * @param {string} key
 */
function revokeKey(store, key) {
	store.revoked ??= [];
	const digest = keyDigest(key);
	if (!store.revoked.includes(digest)) store.revoked.push(digest);
}

/**
 * @param {{ revoked?: string[] }} store
 * @param {string} key
 */
function unrevokeKey(store, key) {
	if (!Array.isArray(store.revoked)) return;
	const digest = keyDigest(key);
	store.revoked = store.revoked.filter((item) => item !== digest);
}

/**
 * Generate a new random API key.
 * @param {string} [prefix]
 */
export function generateApiKey(prefix = "ag-") {
	return `${prefix}${crypto.randomBytes(24).toString("base64url")}`;
}

/**
 * Load the API keys store.
 * Automatically imports the single legacy key file into the store if present.
 * A deleted key is recorded under `revoked` so the legacy api-key file cannot recreate it.
 * @param {string} [storePath]
 * @param {string} [singleKeyFile]
 * @returns {{ revoked: string[], keys: Record<string, { key: string, name: string, enabled: boolean, createdAt: number, updatedAt: number, lastUsedAt: number | null, usage: { requests: number, promptTokens: number, completionTokens: number, totalTokens: number } }> }}
 */
export function loadApiKeysStore(storePath = defaultApiKeysStorePath(), singleKeyFile) {
	/** @type {{ revoked: string[], keys: Record<string, any> }} */
	const store = { revoked: [], keys: {} };

	if (fs.existsSync(storePath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
			if (parsed && typeof parsed === "object" && parsed.keys && typeof parsed.keys === "object") {
				store.keys = parsed.keys;
			}
			if (Array.isArray(parsed?.revoked)) {
				store.revoked = parsed.revoked.filter((item) => typeof item === "string");
			}
		} catch {
			// Corrupt store will be rebuilt
		}
	}

	let modified = false;

	// Import the legacy file once. A revoked digest is never imported again.
	const legacyFile = legacyKeyFile(storePath, singleKeyFile);
	if (legacyFile && fs.existsSync(legacyFile)) {
		try {
			const legacyKey = fs.readFileSync(legacyFile, "utf8").trim();
			if (legacyKey && !store.keys[legacyKey] && !isRevoked(store, legacyKey)) {
				store.keys[legacyKey] = {
					key: legacyKey,
					name: "default",
					enabled: true,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					lastUsedAt: null,
					usage: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
				};
				modified = true;
			}
		} catch {
			// Ignore read error
		}
	}

	if (modified) {
		try {
			writeJsonAtomic(storePath, store);
		} catch {
			// Best effort
		}
	}

	return store;
}

/**
 * Save the API keys store.
 * @param {object} store
 * @param {string} [storePath]
 */
export function saveApiKeysStore(store, storePath = defaultApiKeysStorePath()) {
	writeJsonAtomic(storePath, store);
	return storePath;
}

/**
 * Create a new API key.
 * @param {{ name?: string, key?: string, enabled?: boolean }} [params]
 * @param {{ storePath?: string }} [options]
 */
export function createApiKey(params = {}, options = {}) {
	const storePath = options.storePath ?? defaultApiKeysStorePath();
	const store = loadApiKeysStore(storePath, options.singleKeyFile);

	const key = (params.key?.trim()) || generateApiKey();
	if (store.keys[key]) {
		throw new Error(`API key already exists.`);
	}
	unrevokeKey(store, key);

	const name = (params.name?.trim()) || `key-${Date.now().toString(36)}`;
	const record = {
		key,
		name,
		enabled: params.enabled !== false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		lastUsedAt: null,
		usage: {
			requests: 0,
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		},
	};

	store.keys[key] = record;
	saveApiKeysStore(store, storePath);
	return record;
}

/**
 * Find an API key record by exact key or name (case-insensitive).
 * @param {string} identifier
 * @param {{ storePath?: string }} [options]
 */
export function findApiKey(identifier, options = {}) {
	const store = loadApiKeysStore(options.storePath ?? defaultApiKeysStorePath(), options.singleKeyFile);
	const id = identifier.trim().toLowerCase();

	// Check by key
	if (store.keys[identifier.trim()]) {
		return store.keys[identifier.trim()];
	}

	// Check by name or key case-insensitively
	return Object.values(store.keys).find(
		(k) => k.name.toLowerCase() === id || k.key.toLowerCase() === id,
	);
}

/**
 * Update an API key's name or enabled state.
 * @param {string} identifier
 * @param {{ name?: string, enabled?: boolean }} updates
 * @param {{ storePath?: string }} [options]
 */
export function updateApiKey(identifier, updates, options = {}) {
	const storePath = options.storePath ?? defaultApiKeysStorePath();
	const store = loadApiKeysStore(storePath, options.singleKeyFile);
	const target = findApiKey(identifier, { storePath });

	if (!target) {
		throw new Error(`API key "${identifier}" not found.`);
	}

	const record = store.keys[target.key];
	if (updates.name !== undefined && updates.name.trim()) {
		record.name = updates.name.trim();
	}
	if (updates.enabled !== undefined) {
		record.enabled = Boolean(updates.enabled);
	}
	record.updatedAt = Date.now();

	saveApiKeysStore(store, storePath);
	return record;
}

/**
 * Delete an API key.
 * @param {string} identifier
 * @param {{ storePath?: string }} [options]
 */
export function deleteApiKey(identifier, options = {}) {
	const storePath = options.storePath ?? defaultApiKeysStorePath();
	const store = loadApiKeysStore(storePath, options.singleKeyFile);
	const target = findApiKey(identifier, { storePath });

	if (!target) {
		throw new Error(`API key "${identifier}" not found.`);
	}

	delete store.keys[target.key];
	revokeKey(store, target.key);
	saveApiKeysStore(store, storePath);
	const legacyFile = legacyKeyFile(storePath, options.singleKeyFile);
	if (legacyFile && fs.existsSync(legacyFile)) {
		try {
			if (fs.readFileSync(legacyFile, "utf8").trim() === target.key) fs.rmSync(legacyFile, { force: true });
		} catch {
			// The revoked digest still rejects the key if the file remains.
		}
	}
	return target;
}

/**
 * List all API keys with their details and usage statistics.
 * @param {{ storePath?: string }} [options]
 */
export function listApiKeys(options = {}) {
	const store = loadApiKeysStore(options.storePath ?? defaultApiKeysStorePath(), options.singleKeyFile);
	return Object.values(store.keys).map((k) => ({
		...k,
		usage: { ...(k.usage ?? { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }) },
	}));
}

/**
 * Validate an incoming API key against the master key and the API keys store.
 * @param {string} provided
 * @param {{ masterKey?: string, storePath?: string }} [options]
 * @returns {{ valid: boolean, key?: string, record?: object }}
 */
export function validateApiKey(provided, options = {}) {
	if (!provided) return { valid: false };
	const store = loadApiKeysStore(options.storePath ?? defaultApiKeysStorePath(), options.singleKeyFile);
	if (isRevoked(store, provided)) return { valid: false };

	// 1. Check against master key if configured
	if (options.masterKey && apiKeysMatch(provided, options.masterKey)) {
		const record = store.keys[options.masterKey];
		if (record && record.enabled === false) {
			return { valid: false };
		}
		return { valid: true, key: options.masterKey, record };
	}

	// 2. Check against keys store
	for (const record of Object.values(store.keys)) {
		if (record.enabled !== false && apiKeysMatch(provided, record.key)) {
			return { valid: true, key: record.key, record };
		}
	}

	return { valid: false };
}

/**
 * Record usage statistics for an API key.
 * @param {string} key
 * @param {{ promptTokens?: number, completionTokens?: number, totalTokens?: number }} stats
 * @param {{ storePath?: string }} [options]
 */
export function recordKeyUsage(key, stats = {}, options = {}) {
	if (!key) return null;
	const storePath = options.storePath ?? defaultApiKeysStorePath();
	const store = loadApiKeysStore(storePath, options.singleKeyFile);

	let record = store.keys[key];
	if (!record) {
		// If key not yet in store (e.g. master key passed via flag), create a record for it
		record = {
			key,
			name: "master",
			enabled: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastUsedAt: null,
			usage: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		};
		store.keys[key] = record;
	}

	record.usage ??= { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	record.usage.requests = (record.usage.requests || 0) + 1;

	const prompt = Number(stats.promptTokens) || 0;
	const completion = Number(stats.completionTokens) || 0;
	const total = Number(stats.totalTokens) || (prompt + completion);

	record.usage.promptTokens = (record.usage.promptTokens || 0) + prompt;
	record.usage.completionTokens = (record.usage.completionTokens || 0) + completion;
	record.usage.totalTokens = (record.usage.totalTokens || 0) + total;
	record.lastUsedAt = Date.now();

	saveApiKeysStore(store, storePath);
	return record;
}

/**
 * Reset usage statistics for an API key or all keys.
 * @param {string} [identifier] "all" or specific key/name
 * @param {{ storePath?: string }} [options]
 */
export function resetKeyUsage(identifier, options = {}) {
	const storePath = options.storePath ?? defaultApiKeysStorePath();
	const store = loadApiKeysStore(storePath, options.singleKeyFile);

	let count = 0;
	if (!identifier || identifier.toLowerCase() === "all") {
		for (const record of Object.values(store.keys)) {
			record.usage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
			count += 1;
		}
	} else {
		const target = findApiKey(identifier, { storePath });
		if (!target) {
			throw new Error(`API key "${identifier}" not found.`);
		}
		store.keys[target.key].usage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		count = 1;
	}

	saveApiKeysStore(store, storePath);
	return count;
}

/**
 * Flag, then env, then the key file. A missing file is created once.
 * Also registers the key in api-keys.json if not present.
 * @param {{ key?: string, env?: string, file?: string, storePath?: string }} options
 */
export function resolveServerApiKey(options = {}) {
	if (options.key) return { key: options.key, source: "flag", created: false };
	if (options.env) return { key: options.env, source: "env", created: false };
	const file = options.file ?? defaultApiKeyPath();
	if (fs.existsSync(file)) {
		const key = fs.readFileSync(file, "utf8").trim();
		if (key) {
			loadApiKeysStore(options.storePath ?? defaultApiKeysStorePath(), file);
			return { key, source: "file", path: file, created: false };
		}
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

	// Register in store
	loadApiKeysStore(options.storePath ?? defaultApiKeysStorePath(), file);

	return { key, source: "file", path: file, created: true };
}
