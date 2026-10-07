/**
 * Per-conversation Antigravity envelope: agent id, trajectory, step, and the
 * last Cloud Code Assist endpoint that returned a finished response.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} credentialPath
 */
export function sessionPathFor(credentialPath) {
	return path.join(path.dirname(credentialPath), "session.json");
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
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const json = `${JSON.stringify(
		{
			agentId: state.agentId,
			trajectoryId: state.trajectoryId,
			sessionId: state.sessionId,
			stepIndex: state.stepIndex,
			lastExecutionId: state.lastExecutionId,
			lastGoodEndpoint: state.lastGoodEndpoint,
		},
		null,
		2,
	)}\n`;
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// chmod is not meaningful on every Windows filesystem.
	}
	return file;
}
