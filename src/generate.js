/**
 * Call Antigravity: refresh the OAuth credential from login, select a model,
 * and POST `streamGenerateContent`. Auto mode tries the daily Cloud Code Assist
 * host, then the sandbox host, and remembers the one that finished.
 */
import { AntigravityApiError } from "./errors.js";
import { ensureFreshCredential } from "./credential.js";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "./google-validation.js";
import {
	ANTIGRAVITY_DAILY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
	chooseModel,
	fetchAntigravityDiscovery,
} from "./models.js";
import {
	buildAntigravityRequest,
	consumePlanningBuffer,
	hasMeaningfulContent,
	mapStopReasonString,
	nextToolCallId,
	retainThoughtSignature,
} from "./request.js";
import { loadSession, saveSession } from "./session.js";
import { ensureAntigravityVersion, getAntigravityUserAgent } from "./user-agent.js";

const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 300_000;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
const FIRST_EVENT_TIMEOUT_ERROR = "Cloud Code Assist stream timed out while waiting for the first event";

/**
 * @param {number | undefined} status
 */
export function isTransientStatus(status) {
	return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

/**
 * @param {"auto" | "production" | "sandbox"} [mode]
 * @param {string | undefined} baseUrl
 * @param {string | undefined} lastGoodEndpoint
 */
export function selectAntigravityEndpoints(mode = "auto", baseUrl, lastGoodEndpoint) {
	if (mode === "sandbox") return { endpoints: [ANTIGRAVITY_SANDBOX_ENDPOINT], clearLastGood: true };
	if (mode === "production") return { endpoints: [ANTIGRAVITY_DAILY_ENDPOINT], clearLastGood: true };
	if (baseUrl) {
		const clean = baseUrl.replace(/\/+$/, "");
		if (clean !== ANTIGRAVITY_DAILY_ENDPOINT && clean !== ANTIGRAVITY_SANDBOX_ENDPOINT) {
			return { endpoints: [baseUrl], clearLastGood: true };
		}
	}
	const fallbacks = [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT];
	if (lastGoodEndpoint && fallbacks.includes(lastGoodEndpoint)) {
		return {
			endpoints: [lastGoodEndpoint, ...fallbacks.filter((endpoint) => endpoint !== lastGoodEndpoint)],
			clearLastGood: false,
		};
	}
	return { endpoints: fallbacks, clearLastGood: false };
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" }));
			return;
		}
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		const onAbort = () => {
			clearTimeout(timer);
			reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * @param {AbortSignal | undefined} callerSignal
 * @param {number} ms
 */
function armPreResponseTimeout(callerSignal, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(FIRST_EVENT_TIMEOUT_ERROR)), ms);
	timer.unref?.();
	const onAbort = () => controller.abort(callerSignal?.reason);
	callerSignal?.addEventListener("abort", onAbort, { once: true });
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
	return {
		signal,
		clear() {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onAbort);
		},
	};
}

/**
 * @param {string} message
 * @param {number} [status]
 * @param {string} [kind]
 */
function apiError(message, status, kind) {
	return new AntigravityApiError(message, { status, kind });
}

/**
 * @param {unknown} error
 */
function errorStatus(error) {
	return error instanceof AntigravityApiError ? error.status : undefined;
}

/**
 * @param {unknown} error
 */
function isCallerAbort(error, signal) {
	if (signal?.aborted) return true;
	return error instanceof Error && error.name === "AbortError" && !String(error.message).includes(FIRST_EVENT_TIMEOUT_ERROR);
}

/**
 * @param {unknown} error
 */
function isRetriableNetwork(error) {
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError" && String(error.message).includes(FIRST_EVENT_TIMEOUT_ERROR)) return true;
	if (error instanceof AntigravityApiError && error.kind === "timeout") return true;
	const message = error.message.toLowerCase();
	return (
		error.name === "TypeError" ||
		message.includes("fetch failed") ||
		message.includes("network") ||
		message.includes("econnreset") ||
		message.includes("etimedout") ||
		message.includes("socket hang up") ||
		message.includes(FIRST_EVENT_TIMEOUT_ERROR.toLowerCase())
	);
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal | undefined} signal
 */
async function* readSseJson(body, signal) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) throw Object.assign(new Error("Request was aborted"), { name: "AbortError" });
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data || data === "[DONE]") continue;
				try {
					yield JSON.parse(data);
				} catch (error) {
					throw apiError(`Cloud Code Assist returned invalid stream JSON: ${error instanceof Error ? error.message : String(error)}`, undefined, "parse");
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * @param {AsyncGenerator} source
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
async function* withFirstEventTimeout(source, ms, signal) {
	const iterator = source[Symbol.asyncIterator]();
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(apiError(FIRST_EVENT_TIMEOUT_ERROR, undefined, "timeout")), ms);
		timer.unref?.();
	});
	try {
		const first = await Promise.race([iterator.next(), timeout]);
		clearTimeout(timer);
		if (first.done) return;
		yield first.value;
		while (true) {
			if (signal?.aborted) throw Object.assign(new Error("Request was aborted"), { name: "AbortError" });
			const next = await iterator.next();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		clearTimeout(timer);
	}
}

/**
 * @param {Response} response
 * @param {object} model
 * @param {Set<string>} toolNames
 * @param {AbortSignal | undefined} signal
 * @param {number} firstEventTimeoutMs
 * @param {{ onText?: (delta: string) => void, onThinking?: (delta: string) => void }} hooks
 */
async function consumeStream(response, model, toolNames, signal, firstEventTimeoutMs, hooks) {
	if (!response.body) throw apiError("Cloud Code Assist returned an empty body", response.status, "empty-body");
	/** @type {Array<object>} */
	const content = [];
	let stopReason = "stop";
	let errorMessage;
	let responseId;
	/** @type {object} */
	let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0 };
	let sawFinishReason = false;
	let current = null;
	let buffering = false;
	let textBuffer = "";
	let bufferedSignature;
	const leakWorkaround = model.compat?.flashStreamLeakWorkaround === true;

	const endCurrent = () => {
		current = null;
	};
	const startText = () => {
		if (current?.type !== "text") {
			endCurrent();
			current = { type: "text", text: "" };
			content.push(current);
		}
		return current;
	};
	const startThinking = () => {
		if (current?.type !== "thinking") {
			endCurrent();
			current = { type: "thinking", thinking: "" };
			content.push(current);
		}
		return current;
	};
	const emitText = (delta, signature) => {
		if (!delta) return;
		const block = startText();
		block.text += delta;
		block.textSignature = retainThoughtSignature(block.textSignature, signature);
		hooks.onText?.(delta);
	};

	const chunks = withFirstEventTimeout(readSseJson(response.body, signal), firstEventTimeoutMs, signal);
	for await (const chunk of chunks) {
		if (chunk?.error) {
			const detail = chunk.error.message || chunk.error.status || "unknown error";
			const code = typeof chunk.error.code === "number" ? chunk.error.code : undefined;
			throw apiError(`Cloud Code Assist stream error: ${detail}`, code, "runtime");
		}
		const data = chunk?.response;
		if (!data) continue;
		if (data.responseId) responseId = data.responseId;
		if (!data.candidates?.length && data.promptFeedback?.blockReason) {
			const detail = data.promptFeedback.blockReasonMessage;
			throw apiError(
				`Request blocked by Google (${data.promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`,
				undefined,
				"content-blocked",
			);
		}
		const candidate = data.candidates?.[0];
		if (candidate?.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text !== undefined && part.text !== "") {
					if (part.thought === true) {
						const block = startThinking();
						block.thinking += part.text;
						block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, part.thoughtSignature);
						hooks.onThinking?.(part.text);
					} else if (buffering) {
						textBuffer += part.text;
						bufferedSignature = retainThoughtSignature(bufferedSignature, part.thoughtSignature);
					} else if (leakWorkaround && String(part.text).trimStart().startsWith("{")) {
						buffering = true;
						textBuffer = part.text;
						bufferedSignature = part.thoughtSignature;
					} else {
						emitText(part.text, part.thoughtSignature);
					}
					if (buffering) {
						const buffered = consumePlanningBuffer(textBuffer, toolNames);
						if (buffered.kind !== "incomplete") {
							const signature = bufferedSignature;
							buffering = false;
							textBuffer = "";
							bufferedSignature = undefined;
							emitText(buffered.visibleText, signature);
						}
					}
				} else if (part.text === "" && part.thoughtSignature && !part.functionCall && current) {
					if (current.type === "thinking") {
						current.thinkingSignature = retainThoughtSignature(current.thinkingSignature, part.thoughtSignature);
					} else {
						current.textSignature = retainThoughtSignature(current.textSignature, part.thoughtSignature);
					}
				}
				if (part.functionCall) {
					endCurrent();
					buffering = false;
					textBuffer = "";
					const provided = part.functionCall.id;
					const duplicate = Boolean(provided && content.some((block) => block.type === "toolCall" && block.id === provided));
					const toolCall = {
						type: "toolCall",
						id: !provided || duplicate ? nextToolCallId(part.functionCall.name || "tool") : provided,
						name: part.functionCall.name || "",
						arguments: part.functionCall.args ?? {},
						...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
					};
					content.push(toolCall);
				}
			}
		}
		if (candidate?.finishReason) {
			sawFinishReason = true;
			const mapped = mapStopReasonString(candidate.finishReason);
			if ((mapped === "stop" || mapped === "length") && content.some((block) => block.type === "toolCall")) {
				stopReason = "toolUse";
			} else {
				stopReason = mapped;
				if (mapped === "error") errorMessage = `Generation failed with finish reason: ${candidate.finishReason}`;
			}
		}
		if (data.usageMetadata) {
			const promptTokens = data.usageMetadata.promptTokenCount || 0;
			const cacheRead = data.usageMetadata.cachedContentTokenCount || 0;
			const reasoningTokens = data.usageMetadata.thoughtsTokenCount || 0;
			usage = {
				input: promptTokens - cacheRead,
				output: (data.usageMetadata.candidatesTokenCount || 0) + reasoningTokens,
				cacheRead,
				cacheWrite: 0,
				totalTokens: data.usageMetadata.totalTokenCount || 0,
				reasoningTokens,
			};
		}
	}

	if (buffering && textBuffer) {
		const buffered = consumePlanningBuffer(textBuffer, toolNames, true);
		if (buffered.kind !== "incomplete") emitText(buffered.visibleText, bufferedSignature);
	}

	return {
		content,
		stopReason,
		errorMessage,
		responseId,
		usage,
		sawFinishReason,
		meaningful: hasMeaningfulContent({ content }),
		thoughtOnly: content.some((block) => block.type === "thinking" && (block.thinking?.trim() || block.thinkingSignature)),
	};
}

/**
 * @param {typeof fetch} fetcher
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ attempts: number, sleep: (ms: number, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal, maxDelayMs: number }} retry
 */
async function fetchWithRetry(fetcher, url, init, retry) {
	let lastError;
	for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
		if (retry.signal?.aborted) throw Object.assign(new Error("Request was aborted"), { name: "AbortError" });
		try {
			const response = await fetcher(url, init);
			if (response.ok || !isTransientStatus(response.status) || attempt === retry.attempts - 1) return response;
			lastError = apiError(`Cloud Code Assist API error (${response.status})`, response.status, "http");
		} catch (error) {
			if (retry.signal?.aborted) throw error;
			const timedOut = error instanceof Error && error.name === "AbortError";
			if (timedOut) {
				lastError = apiError(FIRST_EVENT_TIMEOUT_ERROR, undefined, "timeout");
				if (attempt === retry.attempts - 1) throw lastError;
			} else if (!isRetriableNetwork(error) || attempt === retry.attempts - 1) {
				throw error;
			} else {
				lastError = error;
			}
		}
		const backoff = Math.min(BASE_DELAY_MS * 2 ** attempt, retry.maxDelayMs);
		await retry.sleep(backoff, retry.signal);
	}
	throw lastError ?? apiError("Cloud Code Assist request failed", undefined, "network");
}

/**
 * List the logical models this account can call.
 * @param {{
 *   credential: object,
 *   credentialPath?: string,
 *   endpoint?: string,
 *   fetch?: typeof fetch,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   save?: boolean,
 * }} options
 */
export async function listAntigravityModels(options) {
	const credential = await ensureFreshCredential(options.credential, options);
	const discovered = await fetchAntigravityDiscovery({
		token: credential.access,
		endpoint: options.endpoint,
		fetch: options.fetch,
		signal: options.signal,
	});
	if (!discovered) {
		throw new AntigravityApiError("Could not list Antigravity models. Sign in again if this account has no access.", {
			kind: "discovery",
		});
	}
	return { credential, ...discovered };
}

/**
 * @param {{
 *   credential: object,
 *   credentialPath?: string,
 *   model?: string,
 *   models?: object[],
 *   endpoint?: string,
 *   endpointMode?: "auto" | "production" | "sandbox",
 *   systemPrompt?: string | string[],
 *   messages?: object[],
 *   prompt?: string,
 *   tools?: object[],
 *   toolChoice?: string | { allowedFunctionNames?: string[] },
 *   effort?: string,
 *   maxTokens?: number,
 *   temperature?: number,
 *   topP?: number,
 *   topK?: number,
 *   presencePenalty?: number,
 *   hideThinkingSummary?: boolean,
 *   sessionState?: object,
 *   sessionPath?: string,
 *   newSession?: boolean,
 *   fetch?: typeof fetch,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   save?: boolean,
 *   firstEventTimeoutMs?: number,
 *   maxRetryDelayMs?: number,
 *   acceptEmptyResponse?: boolean,
 *   onText?: (delta: string) => void,
 *   onThinking?: (delta: string) => void,
 *   ids?: { now?: () => number, randomUUID?: () => string, randomSessionId?: () => string },
 * }} options
 */
export async function generateAntigravity(options) {
	await ensureAntigravityVersion(options.fetch ?? fetch, options.signal);
	let credential = await ensureFreshCredential(options.credential, options);
	let models = options.models;
	if (!models) {
		const listed = await listAntigravityModels({ ...options, credential });
		credential = listed.credential;
		models = listed.models;
	}
	const selected = chooseModel(models, options.model);
	if (selected.model.kind === "image") {
		throw new AntigravityApiError(`${selected.model.id} is an image model. This client calls chat models.`, {
			kind: "validation",
		});
	}
	const messages = [...(options.messages ?? [])];
	if (options.prompt) messages.push({ role: "user", content: options.prompt });
	if (messages.length === 0) throw new AntigravityApiError("Pass a prompt or at least one message.", { kind: "validation" });

	const state = options.newSession ? {} : (options.sessionState ?? (options.sessionPath ? loadSession(options.sessionPath) : {}));
	const mode = options.endpointMode ?? "auto";
	const routed = selectAntigravityEndpoints(mode, options.endpoint ?? selected.model.baseUrl, state.lastGoodEndpoint);
	if (routed.clearLastGood) state.lastGoodEndpoint = undefined;

	const built = buildAntigravityRequest(
		selected.model,
		{
			systemPrompt: options.systemPrompt,
			messages,
			tools: options.tools,
			toolChoice: options.toolChoice,
			effort: options.effort ?? selected.effort,
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			topP: options.topP,
			topK: options.topK,
			presencePenalty: options.presencePenalty,
			hideThinkingSummary: options.hideThinkingSummary,
		},
		credential.projectId,
		state,
		{ now: options.now, ...options.ids },
	);
	const headers = {
		Authorization: `Bearer ${credential.access}`,
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		"User-Agent": getAntigravityUserAgent(),
	};
	if (selected.model.className === "anthropic" && selected.model.reasoning && selected.model.compat?.claudeThinkingBetaHeader) {
		headers["anthropic-beta"] = CLAUDE_THINKING_BETA_HEADER;
	}
	const body = JSON.stringify(built.body);
	const fetcher = options.fetch ?? fetch;
	const sleep = options.sleep ?? delay;
	const firstEventTimeoutMs =
		options.firstEventTimeoutMs ?? selected.model.compat?.streamFirstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
	const toolNames = new Set((options.tools ?? []).map((tool) => tool.name));
	let started = false;
	let lastError;

	for (let index = 0; index < routed.endpoints.length; index += 1) {
		const endpoint = routed.endpoints[index].replace(/\/+$/, "");
		const isLast = index === routed.endpoints.length - 1;
		started = false;
		try {
			const url = `${endpoint}${STREAM_PATH}`;
			const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
			let response;
			try {
				response = await fetchWithRetry(fetcher, url, { method: "POST", headers, body, signal: watchdog.signal }, {
					attempts: isLast ? MAX_RETRIES + 1 : 1,
					sleep,
					signal: options.signal,
					maxDelayMs: options.maxRetryDelayMs ?? RATE_LIMIT_BUDGET_MS,
				});
			} finally {
				watchdog.clear();
			}
			if (!response.ok) {
				const errorText = await response.text();
				if (isTransientStatus(response.status) && !isLast) continue;
				const validationUrl = extractGoogleValidationUrl(errorText);
				const message = validationUrl
					? formatGoogleValidationRequiredMessage(validationUrl, "retry your request", credential.email)
					: `Cloud Code Assist API error (${response.status}): ${errorText}`;
				throw apiError(message, response.status, validationUrl ? "validation" : "http");
			}

			let current = response;
			/** @type {Awaited<ReturnType<typeof consumeStream>> | undefined} */
			let streamed;
			for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt += 1) {
				if (options.signal?.aborted) throw Object.assign(new Error("Request was aborted"), { name: "AbortError" });
				if (emptyAttempt > 0) {
					await sleep(EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1), options.signal);
					current = await fetcher(url, { method: "POST", headers, body, signal: options.signal });
					if (!current.ok) {
						const retryText = await current.text();
						throw apiError(`Cloud Code Assist API error (${current.status}): ${retryText}`, current.status, "http");
					}
				}
				streamed = await consumeStream(current, selected.model, toolNames, options.signal, firstEventTimeoutMs, {
					...options,
					onText(delta) {
						started = true;
						options.onText?.(delta);
					},
					onThinking(delta) {
						started = true;
						options.onThinking?.(delta);
					},
				});
				if (streamed.toolCalls?.length || streamed.content.some((block) => block.type === "toolCall")) started = true;
				const accepted = options.acceptEmptyResponse === true && (isLast || streamed.thoughtOnly);
				if (streamed.stopReason !== "stop" || streamed.meaningful || accepted) break;
				if (streamed.thoughtOnly) break;
			}
			if (!streamed) throw apiError("Cloud Code Assist returned an empty response", undefined, "empty-body");
			if (streamed.stopReason === "error") {
				throw apiError(streamed.errorMessage ?? "Generation failed", undefined, "output");
			}
			const thoughtOnly = streamed.thoughtOnly && !streamed.meaningful;
			if (!streamed.meaningful && options.acceptEmptyResponse !== true) {
				throw apiError(
					thoughtOnly
						? "Cloud Code Assist API returned a thought-only response without final output"
						: "Cloud Code Assist API returned an empty response",
					undefined,
					thoughtOnly ? "empty-output" : "empty-body",
				);
			}
			if (!streamed.sawFinishReason) {
				throw apiError(
					"Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)",
					undefined,
					"incomplete-stream",
				);
			}
			if (mode === "auto") state.lastGoodEndpoint = endpoint;
			state.lastExecutionId = streamed.responseId;
			if (options.sessionPath && options.save !== false) saveSession(state, options.sessionPath);
			const text = streamed.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			const thinking = streamed.content
				.filter((block) => block.type === "thinking")
				.map((block) => block.thinking)
				.join("");
			return {
				text,
				thinking,
				toolCalls: streamed.content.filter((block) => block.type === "toolCall"),
				content: streamed.content,
				stopReason: streamed.stopReason,
				usage: streamed.usage,
				model: selected.model.id,
				wireModelId: built.resolved.wireModelId,
				effort: built.resolved.effort,
				endpoint,
				responseId: streamed.responseId,
				session: state,
				credential,
			};
		} catch (error) {
			if (isCallerAbort(error, options.signal)) throw error;
			const status = errorStatus(error);
			const retriable = isTransientStatus(status) || (status === undefined && isRetriableNetwork(error));
			if (!isLast && !started && retriable) {
				lastError = error;
				continue;
			}
			throw error;
		}
	}
	throw lastError ?? apiError("Cloud Code Assist request failed", undefined, "network");
}
