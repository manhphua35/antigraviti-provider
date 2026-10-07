/**
 * Local chat server.
 * Callers send an API key, an optional effort (default medium), and the prompt,
 * messages, and tools. The server calls gemini-3.8-flash the way omp does:
 * straight to streamGenerateContent, with the session envelope kept across calls.
 */
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { isQuotaError, markQuotaExhausted, rotateToNextAvailableAccount } from "./accounts.js";
import { apiKeysMatch, recordKeyUsage, validateApiKey } from "./api-key.js";
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
import { saveSession, sessionPathFor } from "./session.js";

const BODY_LIMIT = 8 * 1024 * 1024;

/**
 * @param {import("node:http").IncomingMessage} req
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > BODY_LIMIT) {
				reject(new ChatRequestError("Request body is too large", 413));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
 * }} options
 */
export function createChatServer(options) {
	const generate = options.generate ?? generateAntigravity;
	let callChain = Promise.resolve();
	const enqueueCall = (task) => {
		const run = callChain.then(task, task);
		callChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
	return http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const baseDir = options.credentialPath ? path.dirname(options.credentialPath) : undefined;
		const apiKeysPath = options.apiKeysPath ?? (baseDir ? path.join(baseDir, "api-keys.json") : undefined);
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
			const raw = await readBody(req);
			let parsed;
			try {
				parsed = raw.trim() ? JSON.parse(raw) : {};
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
			let currentCredential = credential;
			const autoRotate = options.autoRotate !== false;
			const triedAccounts = new Set();
			if (currentCredential?.email) triedAccounts.add(currentCredential.email.toLowerCase());
			let result;
			while (true) {
				try {
					result = await enqueueCall(() =>
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
							sessionPath: options.credentialPath ? sessionPathFor(options.credentialPath) : undefined,
							signal: abort.signal,
							onText(delta) {
								if (!chat.stream || !delta) return;
								streamId ??= `chatcmpl-${crypto.randomUUID()}`;
								writeChunk(formatChatChunk(streamId, { content: delta }, null));
							},
						}),
					);
					break;
				} catch (error) {
					if (autoRotate && isQuotaError(error) && !started) {
						const currentEmail = currentCredential?.email;
						const baseDir = options.credentialPath ? path.dirname(options.credentialPath) : undefined;
						const accountsDir = options.accountsDir ?? (baseDir ? path.join(baseDir, "accounts") : undefined);
						const indexPath = options.accountsIndexPath ?? (baseDir ? path.join(baseDir, "accounts.json") : undefined);

						if (currentEmail) {
							markQuotaExhausted(currentEmail, { accountsDir, indexPath });
						}
						const rotation = rotateToNextAvailableAccount(currentEmail, {
							accountsDir,
							indexPath,
							credentialPath: options.credentialPath,
						});
						if (rotation.rotated && rotation.credential && rotation.newEmail && !triedAccounts.has(rotation.newEmail.toLowerCase())) {
							triedAccounts.add(rotation.newEmail.toLowerCase());
							options.onRotate?.({ from: currentEmail, to: rotation.newEmail });
							currentCredential = rotation.credential;
							if (options.credentialPath) {
								try {
									const sPath = sessionPathFor(options.credentialPath);
									saveSession({}, sPath);
								} catch {
									// Best effort
								}
							}
							continue;
						}
					}
					throw error;
				}
			}
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
