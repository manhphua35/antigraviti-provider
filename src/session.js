/**
 * Per-conversation Antigravity envelope: agent id, trajectory, step, and the
 * last Cloud Code Assist endpoint that returned a finished response.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./store.js";

/**
 * Stable directory name for one client key (and optional conversation seed).
 * The raw key and conversation text never appear in the path.
 * @param {string} apiKey
 * @param {string} [conversationSeed]
 */
export function sessionScopeForKey(apiKey, conversationSeed) {
	const base = String(apiKey ?? "");
	const seed = typeof conversationSeed === "string" ? conversationSeed.trim() : "";
	const input = seed ? `${base}\0${seed}` : base;
	return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/**
 * CLI calls share session.json. The HTTP server passes a per-key scope so
 * unrelated clients do not advance one Antigravity trajectory.
 * @param {string} credentialPath
 * @param {string} [scope]
 */
export function sessionPathFor(credentialPath, scope) {
	const dir = path.dirname(credentialPath);
	if (!scope) return path.join(dir, "session.json");
	const safe = String(scope).replace(/[^a-z0-9]/gi, "").slice(0, 64);
	return path.join(dir, "sessions", `${safe}.json`);
}

/**
 * @param {string} file
 */
export function loadSession(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return {
			agentId: typeof parsed.agentId === "string" ? parsed.agentId : undefined,
			trajectoryId: typeof parsed.trajectoryId === "string" ? parsed.trajectoryId : undefined,
			sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
			stepIndex: typeof parsed.stepIndex === "number" ? parsed.stepIndex : undefined,
			lastExecutionId: typeof parsed.lastExecutionId === "string" ? parsed.lastExecutionId : undefined,
			lastGoodEndpoint: typeof parsed.lastGoodEndpoint === "string" ? parsed.lastGoodEndpoint : undefined,
			toolSignatures: readToolSignatures(parsed.toolSignatures),
		};
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return {};
		throw error;
	}
}

/**
 * @param {object} state
 * @param {string} file
 */
export function saveSession(state, file) {
	return writeJsonAtomic(file, {
		agentId: state.agentId,
		trajectoryId: state.trajectoryId,
		sessionId: state.sessionId,
		stepIndex: state.stepIndex,
		lastExecutionId: state.lastExecutionId,
		lastGoodEndpoint: state.lastGoodEndpoint,
		toolSignatures: state.toolSignatures,
	});
}

const MAX_TOOL_SIGNATURES = 500;
const MAX_TOOL_SIGNATURE_LENGTH = 16384;

function readToolSignatures(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	/** @type {Record<string, { signature: string, wireModelId: string }>} */
	const out = {};
	for (const [id, entry] of Object.entries(value)) {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const signature = /** @type {{ signature?: unknown, wireModelId?: unknown }} */ (entry).signature;
		const wireModelId = /** @type {{ signature?: unknown, wireModelId?: unknown }} */ (entry).wireModelId;
		if (typeof signature !== "string" || signature.length === 0 || signature.length > MAX_TOOL_SIGNATURE_LENGTH) continue;
		if (typeof wireModelId !== "string" || wireModelId.length === 0 || wireModelId.length > 128) continue;
		out[id] = { signature, wireModelId };
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export function rememberToolSignature(state, id, signature, wireModelId) {
	if (!state || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
	if (typeof signature !== "string" || signature.length === 0 || signature.length > MAX_TOOL_SIGNATURE_LENGTH) return;
	if (typeof wireModelId !== "string" || wireModelId.length === 0 || wireModelId.length > 128) return;
	if (!state.toolSignatures || typeof state.toolSignatures !== "object" || Array.isArray(state.toolSignatures)) {
		state.toolSignatures = {};
	}
	if (Object.prototype.hasOwnProperty.call(state.toolSignatures, id)) delete state.toolSignatures[id];
	state.toolSignatures[id] = { signature, wireModelId };
	const ids = Object.keys(state.toolSignatures);
	if (ids.length <= MAX_TOOL_SIGNATURES) return;
	for (const oldId of ids.slice(0, ids.length - MAX_TOOL_SIGNATURES)) delete state.toolSignatures[oldId];
}

export function rememberToolSignatures(state, content, wireModelId) {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.thoughtSignature !== "string") continue;
		rememberToolSignature(state, block.id, block.thoughtSignature, wireModelId);
	}
}
