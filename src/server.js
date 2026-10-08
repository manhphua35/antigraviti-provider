/**
 * Local chat server.
 * Callers send an API key, an optional effort (default medium), and the prompt,
 * messages, and tools. The server calls gemini-3.8-flash the way omp does:
 * straight to streamGenerateContent, with the session envelope kept across calls.
 */
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { withQuotaRotation } from "./accounts.js";
import { recordKeyUsage, validateApiKey } from "./api-key.js";
import {
	ChatRequestError,
	DEFAULT_SERVER_EFFORT,
	SERVER_MODEL_ID,
	formatChatChunk,
	formatChatCompletion,
	formatModelObject,
	formatModelsList,
	normalizeChatRequest,
	readRequestApiKey,
} from "./chat.js";
import { AntigravityApiError } from "./errors.js";
import { generateAntigravity } from "./generate.js";
import { catalogAntigravityModel } from "./models.js";
import { sessionPathFor, sessionScopeForKey } from "./session.js";

export const MB = 1024 * 1024;
export const DEFAULT_BODY_LIMIT = 20 * MB;

/**
 * @param {number} bytes
 */
export function formatMegabytes(bytes) {
	return `${(bytes / MB).toFixed(1)}MB`;
}

/**
 * Over the limit, drop the bytes but keep reading to the end. Destroying the
 * request here would reset the socket before the 413 is written, and the client
 * would only see a dropped connection. The caller checks `size` against the limit.
 * @param {import("node:http").IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<{ text: string, size: number }>}
 */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		let chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				chunks = [];
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), size }));
		req.on("error", reject);
	});
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
	if (res.writableEnded) return;
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function sendError(res, status, message) {
	sendJson(res, status, { error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error" } });
}

/**
 * @param {unknown} error
 */
function errorStatus(error) {
	if (error instanceof ChatRequestError) return error.status;
	if (error instanceof AntigravityApiError) {
		if (error.kind === "validation") return 400;
		if (typeof error.status === "number" && error.status >= 400 && error.status < 500) return error.status;
		return 502;
	}
	const code = /** @type {NodeJS.ErrnoException} */ (error).code;
	if (code === "ENOENT") return 503;
	return 500;
}

/**
 * @param {{
 *   apiKey: string,
 *   credentialPath?: string,
 *   loadCredential: () => object,
 *   generate?: typeof generateAntigravity,
 *   endpoint?: string,
 *   endpointMode?: "auto" | "production" | "sandbox",
 *   bodyLimit?: number,
 *   log?: (line: string) => void,
 * }} options
 */
export function createChatServer(options) {
	const generate = options.generate ?? generateAntigravity;
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	/** @type {Map<string, Promise<void>>} */
	const callChains = new Map();
	// One in-flight call per client key. Different keys do not share a trajectory, so they can run together.
	const enqueueCall = (key, task) => {
		const prev = callChains.get(key) ?? Promise.resolve();
		const run = prev.then(task, task);
		const settled = run.then(
			() => undefined,
			() => undefined,
		);
		callChains.set(key, settled);
		settled.then(() => {
			if (callChains.get(key) === settled) callChains.delete(key);
		});
		return run;
	};
	return http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const baseDir = options.credentialPath ? path.dirname(options.credentialPath) : undefined;
		const apiKeysPath = options.apiKeysPath ?? (baseDir ? path.join(baseDir, "api-keys.json") : undefined);
		const accountsDir = options.accountsDir ?? (baseDir ? path.join(baseDir, "accounts") : undefined);
		const accountsIndexPath = options.accountsIndexPath ?? (baseDir ? path.join(baseDir, "accounts.json") : undefined);
		const startedAt = Date.now();
		/** @type {number | undefined} */
		let bodyBytes;
		/** @type {string | undefined} */
		let failure;
		if (options.log && req.method === "POST") {
			res.on("close", () => {
				const status = res.writableFinished ? String(res.statusCode) : "aborted";
				const fields = [req.method, url.pathname, status];
				if (bodyBytes !== undefined) fields.push(`body=${formatMegabytes(bodyBytes)}`);
				fields.push(`${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
				if (failure) fields.push(`error=${JSON.stringify(failure.slice(0, 300))}`);
				try {
					options.log(fields.join(" "));
				} catch {
					// Logging must not affect the response.
				}
			});
		}
		try {
			if (req.method === "GET") {
				if (url.pathname === "/" || url.pathname === "/health") {
					sendJson(res, 200, { ok: true, model: SERVER_MODEL_ID, defaultEffort: DEFAULT_SERVER_EFFORT });
					return;
				}
				if (url.pathname === "/v1/models" || url.pathname === "/models") {
					const presented = readRequestApiKey(req);
					const keyAuth = validateApiKey(presented, { masterKey: options.apiKey, storePath: apiKeysPath });
					if (!keyAuth.valid) {
						sendError(res, 401, "Invalid API key");
						return;
					}
					sendJson(res, 200, formatModelsList());
					return;
				}
				if (url.pathname.startsWith("/v1/models/") || url.pathname.startsWith("/models/")) {
					const presented = readRequestApiKey(req);
					const keyAuth = validateApiKey(presented, { masterKey: options.apiKey, storePath: apiKeysPath });
					if (!keyAuth.valid) {
						sendError(res, 401, "Invalid API key");
						return;
					}
					const requestedModel = url.pathname.replace(/^\/(?:v1\/)?models\//, "");
					if (requestedModel === SERVER_MODEL_ID) {
						sendJson(res, 200, formatModelObject(SERVER_MODEL_ID));
						return;
					}
					sendError(res, 404, `The model '${requestedModel}' does not exist`);
					return;
				}
			}
			if (req.method !== "POST" || (url.pathname !== "/v1/chat/completions" && url.pathname !== "/v1/generate")) {
				sendError(res, req.method === "POST" ? 404 : 405, "Not found");
				return;
			}
			const body = await readBody(req, bodyLimit);
			bodyBytes = body.size;
			if (body.size > bodyLimit) {
				throw new ChatRequestError(
					`Request body is too large (${formatMegabytes(body.size)}, limit ${formatMegabytes(bodyLimit)})`,
					413,
				);
			}
			let parsed;
			try {
				parsed = body.text.trim() ? JSON.parse(body.text) : {};
			} catch {
				sendError(res, 400, "Request body is not JSON");
				return;
			}
			const presented = readRequestApiKey(req, parsed);
			const keyAuth = validateApiKey(presented, { masterKey: options.apiKey, storePath: apiKeysPath });
			if (!keyAuth.valid) {
				sendError(res, 401, "Invalid API key");
				return;
			}
			const chat = normalizeChatRequest(parsed);
			const abort = new AbortController();
			req.on("close", () => {
				if (!res.writableEnded) abort.abort();
			});
			const catalogModel = catalogAntigravityModel(chat.model, options.endpoint);
			if (!catalogModel) {
				sendError(res, 400, `Unknown model "${chat.model}".`);
				return;
			}
			const credential = options.loadCredential();
			/** @type {string | undefined} */
			let streamId;
			let started = false;
			const writeChunk = (chunk) => {
				if (!started) {
					res.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					});
					started = true;
				}
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			const autoRotate = options.autoRotate !== false;
			const sessionScope = sessionScopeForKey(keyAuth.key || presented || "anonymous");
			const sessionPath = options.credentialPath ? sessionPathFor(options.credentialPath, sessionScope) : undefined;
			const result = await enqueueCall(sessionScope, () =>
				withQuotaRotation({
					credential,
					autoRotate,
					credentialPath: options.credentialPath,
					accountsDir,
					indexPath: accountsIndexPath,
					sessionPath,
					canRotate: () => !started,
					onRotate: options.onRotate,
					run: (currentCredential) =>
						generate({
							credential: currentCredential,
							credentialPath: options.credentialPath,
							endpoint: options.endpoint,
							endpointMode: options.endpointMode,
							model: chat.model,
							models: [catalogModel],
							effort: chat.effort,
							systemPrompt: chat.systemPrompt,
							messages: chat.messages,
							prompt: chat.prompt,
							tools: chat.tools,
							toolChoice: chat.toolChoice,
							maxTokens: chat.maxTokens,
							temperature: chat.temperature,
							topP: chat.topP,
							topK: chat.topK,
							presencePenalty: chat.presencePenalty,
							sessionPath,
							signal: abort.signal,
							retryRateLimit: !autoRotate,
							onText(delta) {
								if (!chat.stream || !delta) return;
								streamId ??= `chatcmpl-${crypto.randomUUID()}`;
								writeChunk(formatChatChunk(streamId, { content: delta }, null));
							},
						}),
				}),
			);
			if (chat.stream) {
				streamId ??= `chatcmpl-${result.responseId ?? crypto.randomUUID()}`;
				const calls = result.toolCalls ?? [];
				if (calls.length > 0) {
					writeChunk(
						formatChatChunk(
							streamId,
							{
								tool_calls: calls.map((call, index) => ({
									index,
									id: call.id,
									type: "function",
									function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
								})),
							},
							null,
						),
					);
				}
				const finish = result.stopReason === "length" ? "length" : calls.length > 0 ? "tool_calls" : "stop";
				writeChunk(formatChatChunk(streamId, {}, finish));
				if (chat.streamOptions?.includeUsage) {
					writeChunk({
						id: streamId,
						object: "chat.completion.chunk",
						model: SERVER_MODEL_ID,
						choices: [],
						usage: {
							prompt_tokens: result.usage?.input ?? 0,
							completion_tokens: result.usage?.output ?? 0,
							total_tokens: result.usage?.totalTokens ?? 0,
						},
					});
				}
				res.end("data: [DONE]\n\n");
				if (keyAuth.key) {
					try {
						recordKeyUsage(keyAuth.key, {
							promptTokens: result.usage?.input,
							completionTokens: result.usage?.output,
							totalTokens: result.usage?.totalTokens,
						}, { storePath: apiKeysPath });
					} catch {
						// Best effort
					}
				}
				return;
			}
			sendJson(res, 200, formatChatCompletion(result));
			if (keyAuth.key) {
				try {
					recordKeyUsage(keyAuth.key, {
						promptTokens: result.usage?.input,
						completionTokens: result.usage?.output,
						totalTokens: result.usage?.totalTokens,
					}, { storePath: apiKeysPath });
				} catch {
					// Best effort
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			try {
				if (res.writableEnded || res.headersSent) {
					res.end();
					return;
				}
				const status = errorStatus(error);
				const message = status === 503 ? "Not logged in. Run: node src/cli.js login" : error instanceof Error ? error.message : String(error);
				sendError(res, status, message);
			} catch {
				res.destroy();
			}
		}
	});
}

/**
 * @param {import("node:http").Server} server
 * @param {{ host?: string, port?: number }} address
 */
export function listen(server, address = {}) {
	const host = address.host ?? "127.0.0.1";
	const port = address.port ?? 8787;
	server.requestTimeout = 0;
	return new Promise((resolve, reject) => {
		const onError = (error) => reject(error);
		server.once("error", onError);
		server.listen(port, host, () => {
			server.off("error", onError);
			const value = server.address();
			resolve(typeof value === "object" && value ? value : { address: host, port, family: "IPv4" });
		});
	});
}
