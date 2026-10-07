/**
 * Per-conversation Antigravity envelope: agent id, trajectory, step, and the
 * last Cloud Code Assist endpoint that returned a finished response.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./store.js";

/**
 * Stable directory name for one client key. The raw key never appears in the path.
 * @param {string} apiKey
 */
export function sessionScopeForKey(apiKey) {
	return crypto.createHash("sha256").update(String(apiKey ?? "")).digest("hex").slice(0, 32);
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
	});
}
