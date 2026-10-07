/**
 * Antigravity `streamGenerateContent` request body.
 * Mirrors `buildRequest(..., isAntigravity)` in oh-my-pi's google-gemini-cli provider.
 */
import crypto from "node:crypto";
import { AntigravityApiError } from "./errors.js";
import { getAntigravityModelWireProfile, resolveThinking } from "./models.js";
import { normalizeSchemaForCca } from "./schema.js";

const INT63_MASK = (1n << 63n) - 1n;
const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
export const FORCED_TOOL_DIRECTIVE =
	"TOOL-ONLY TURN. This turn accepts a tool call and nothing else; a text reply here is discarded unread and you will be re-prompted. Emit the tool call now.\n";

let toolCallCounter = 0;

/**
 * @param {string} name
 */
export function nextToolCallId(name) {
	toolCallCounter += 1;
	return `${name}_${Date.now()}_${toolCallCounter}`;
}

/**
 * @param {string} text
 */
export function wellFormed(text) {
	const value = String(text);
	return typeof value.toWellFormed === "function" ? value.toWellFormed() : value;
}

/**
 * @param {bigint} value
 */
function formatSignedDecimalSessionId(value) {
	return `-${value.toString()}`;
}

/**
 * @param {string} text
 */
export function deriveSignedDecimalFromHash(text) {
	const digest = crypto.createHash("sha256").update(text).digest();
	let value = 0n;
	for (let index = 0; index < 8; index += 1) {
		value = (value << 8n) | BigInt(digest[index] ?? 0);
	}
	return formatSignedDecimalSessionId(value & INT63_MASK);
}

/**
 * @param {bigint} maxExclusive
 * @param {() => Buffer} [bytes]
 */
function randomBoundedInt63(maxExclusive, bytes = () => crypto.randomBytes(8)) {
	while (true) {
		const chunk = bytes();
		let value = 0n;
		for (const byte of chunk) value = (value << 8n) | BigInt(byte);
		value &= INT63_MASK;
		if (value < maxExclusive) return value;
	}
}

/**
 * @param {() => Buffer} [bytes]
 */
export function randomSignedDecimalSessionId(bytes) {
	return formatSignedDecimalSessionId(randomBoundedInt63(ANTIGRAVITY_RANDOM_BOUND, bytes));
}

/**
 * @param {string | undefined} signature
 */
function isValidThoughtSignature(signature) {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return SIGNATURE_PATTERN.test(signature);
}

/**
 * @param {string | undefined} existing
 * @param {string | undefined} incoming
 */
export function retainThoughtSignature(existing, incoming) {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

/**
 * @param {string} text
 * @param {Set<string>} toolNames
 * @param {boolean} [isFinal]
 * @returns {{ kind: "incomplete" } | { kind: "plain", visibleText: string } | { kind: "leak", visibleText: string }}
 */
export function consumePlanningBuffer(text, toolNames, isFinal = false) {
	if (!isPlanningLeakPrefix(text)) return { kind: "plain", visibleText: text };
	const leading = splitLeadingJsonObject(text) ?? splitLeadingJsonObjectIgnoringQuotes(text);
	if (!leading) {
		if (!isFinal) return { kind: "incomplete" };
		const trimmed = text.trim();
		const hasThoughtKey = trimmed.includes('"thought"');
		const hasToolKey = [...toolNames].some((name) => trimmed.includes(`"${name}"`));
		const hasToolSignature =
			trimmed.includes('"_i"') ||
			trimmed.includes('"paths"') ||
			trimmed.includes('"command"') ||
			(trimmed.includes('"path"') && trimmed.includes('"content"'));
		if (hasThoughtKey || hasToolKey || hasToolSignature) return { kind: "leak", visibleText: "" };
		return { kind: "plain", visibleText: text };
	}
	try {
		const parsed = JSON.parse(leading.jsonText);
		return isPlanningLeakObject(parsed, toolNames)
			? { kind: "leak", visibleText: leading.rest }
			: { kind: "plain", visibleText: text };
	} catch {
		const hasThoughtKey = leading.jsonText.includes('"thought"');
		const hasToolKey = [...toolNames].some((name) => leading.jsonText.includes(`"${name}"`));
		const hasToolSignature =
			leading.jsonText.includes('"_i"') ||
			leading.jsonText.includes('"paths"') ||
			leading.jsonText.includes('"command"') ||
			(leading.jsonText.includes('"path"') && leading.jsonText.includes('"content"'));
		if (hasThoughtKey || hasToolKey || hasToolSignature) return { kind: "leak", visibleText: leading.rest };
		return { kind: "plain", visibleText: text };
	}
}

/**
 * @param {string} text
 */
function isPlanningLeakPrefix(text) {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{")) return false;
	const afterBrace = trimmed.slice(1).trimStart();
	if (afterBrace === "") return trimmed.length <= 100;
	if (afterBrace[0] !== '"') return false;
	const nextQuoteIndex = afterBrace.indexOf('"', 1);
	if (nextQuoteIndex === -1) {
		const keyPrefix = afterBrace.slice(1);
		return "thought".startsWith(keyPrefix) && trimmed.length <= 100;
	}
	const key = afterBrace.slice(1, nextQuoteIndex);
	if (key !== "thought") return false;
	const afterKey = afterBrace.slice(nextQuoteIndex + 1).trimStart();
	if (afterKey === "") return trimmed.length <= 100;
	return afterKey[0] === ":";
}

/**
 * @param {unknown} parsed
 * @param {Set<string>} toolNames
 */
function isPlanningLeakObject(parsed, toolNames) {
	if (!parsed || typeof parsed !== "object") return false;
	const record = /** @type {Record<string, unknown>} */ (parsed);
	const hasThought = typeof record.thought === "string";
	const isTool = typeof record.call === "string" && toolNames.has(record.call);
	const hasToolSignature =
		"_i" in record || "paths" in record || "command" in record || ("path" in record && "content" in record);
	return hasThought || isTool || hasToolSignature;
}

/**
 * @param {string} text
 */
function splitLeadingJsonObject(text) {
	const prefixLength = text.length - text.trimStart().length;
	const trimmed = text.slice(prefixLength);
	if (!trimmed.startsWith("{")) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < trimmed.length; index += 1) {
		const ch = trimmed[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			depth += 1;
			continue;
		}
		if (ch !== "}") continue;
		depth -= 1;
		if (depth !== 0) continue;
		return {
			prefixLength: prefixLength + index + 1,
			jsonText: trimmed.slice(0, index + 1),
			rest: trimmed.slice(index + 1),
		};
	}
	return undefined;
}

/**
 * @param {string} text
 */
function splitLeadingJsonObjectIgnoringQuotes(text) {
	const prefixLength = text.length - text.trimStart().length;
	const trimmed = text.slice(prefixLength);
	if (!trimmed.startsWith("{")) return undefined;
	let depth = 0;
	for (let index = 0; index < trimmed.length; index += 1) {
		const ch = trimmed[index];
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				return {
					prefixLength: prefixLength + index + 1,
					jsonText: trimmed.slice(0, index + 1),
					rest: trimmed.slice(index + 1),
				};
			}
		}
	}
	return undefined;
}

/**
 * @param {string} choice
 */
export function mapToolChoice(choice) {
	if (choice === "none") return "NONE";
	if (choice === "any") return "ANY";
	return "AUTO";
}

/**
 * @param {string} reason
 */
export function mapStopReasonString(reason) {
	if (reason === "STOP") return "stop";
	if (reason === "MAX_TOKENS") return "length";
	return "error";
}

/**
 * @param {{ content?: Array<{ type: string, text?: string }> }} output
 */
export function hasMeaningfulContent(output) {
	for (const block of output.content ?? []) {
		if (block.type === "toolCall") return true;
		if (block.type === "text" && block.text?.trim()) return true;
	}
	return false;
}

/**
 * @param {unknown} systemPrompt
 * @returns {string[]}
 */
function normalizeSystemPrompts(systemPrompt) {
	if (!systemPrompt) return [];
	const list = Array.isArray(systemPrompt) ? systemPrompt : [systemPrompt];
	return list.filter((text) => typeof text === "string" && text.trim() !== "");
}

/**
 * @param {string} id
 */
function normalizeToolCallId(id) {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * @param {{ mimeType?: string, data?: string, url?: string }} image
 */
function convertImagePart(image) {
	if (typeof image.data === "string" && image.data) {
		return { inlineData: { mimeType: image.mimeType || "image/png", data: image.data } };
	}
	if (image.url) {
		throw new AntigravityApiError("Image URLs must be inline data URLs. Remote image links are not sent upstream.", {
			kind: "validation",
		});
	}
	return { inlineData: { mimeType: image.mimeType || "image/png", data: image.data ?? "" } };
}

/**
 * @param {unknown} content
 * @returns {Array<{ type: string, text?: string }>}
 */
function asBlocks(content) {
	if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
	if (Array.isArray(content)) return content;
	return [];
}

/**
 * @param {object} model
 * @param {Array<object>} messages
 */
export function convertMessages(model, messages) {
	/** @type {Array<{ role: string, parts: object[] }>} */
	const contents = [];
	/** @type {Map<string, string>} */
	const emittedToolCallNames = new Map();
	/** @type {object[]} */
	let pendingToolImageParts = [];
	const flushPendingToolImages = () => {
		if (pendingToolImageParts.length === 0) return;
		contents.push({ role: "user", parts: pendingToolImageParts });
		pendingToolImageParts = [];
	};
	const supportsImages = model.input?.includes("image") === true;

	for (const message of messages ?? []) {
		if (message.role !== "toolResult" && message.role !== "tool") flushPendingToolImages();
		if (message.role === "user" || message.role === "developer") {
			if (typeof message.content === "string") {
				if (!message.content.trim()) continue;
				contents.push({ role: "user", parts: [{ text: wellFormed(message.content) }] });
				continue;
			}
			/** @type {object[]} */
			const parts = [];
			let omittedImages = false;
			for (const item of asBlocks(message.content)) {
				if (item.type === "text") {
					const text = wellFormed(item.text ?? "");
					if (!text.trim()) continue;
					parts.push({ text });
				} else if (item.type === "image" && supportsImages) {
					parts.push(convertImagePart(item));
				} else if (item.type === "image") {
					omittedImages = true;
				}
			}
			if (omittedImages) parts.push({ text: NON_VISION_IMAGE_PLACEHOLDER });
			if (parts.length === 0) continue;
			contents.push({ role: "user", parts });
		} else if (message.role === "assistant" || message.role === "model") {
			/** @type {object[]} */
			const parts = [];
			const sameModel = message.provider === model.provider && message.model === model.id;
			const dropUnsigned = model.compat?.dropUnsignedThinking === true;
			let isFirstToolCall = true;
			const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
			for (const block of blocks) {
				if (block.type === "text") {
					if (!block.text || !String(block.text).trim()) continue;
					const signature =
						sameModel && isValidThoughtSignature(block.textSignature) ? block.textSignature : undefined;
					parts.push({ text: wellFormed(block.text), ...(signature ? { thoughtSignature: signature } : {}) });
				} else if (block.type === "thinking") {
					if (!block.thinking || !String(block.thinking).trim()) continue;
					const signature =
						sameModel && isValidThoughtSignature(block.thinkingSignature) ? block.thinkingSignature : undefined;
					if (dropUnsigned && !signature) continue;
					if (signature) {
						parts.push({ thought: true, text: wellFormed(block.thinking), thoughtSignature: signature });
					} else if (model.className === "anthropic") {
						parts.push({ text: wellFormed(block.thinking) });
					} else {
						parts.push({ text: `<think>\n${wellFormed(block.thinking)}\n</think>` });
					}
				} else if (block.type === "toolCall") {
					const id = normalizeToolCallId(String(block.id ?? nextToolCallId(block.name || "tool")));
					emittedToolCallNames.set(block.id, block.name);
					emittedToolCallNames.set(id, block.name);
					const signature =
						sameModel && isValidThoughtSignature(block.thoughtSignature) ? block.thoughtSignature : undefined;
					const requiresFallback =
						model.compat?.requiresSkipThoughtSignature === true ||
						(isFirstToolCall && model.compat?.requiresSkipThoughtSignatureOnFirstFunctionCall === true);
					const effective = signature || (requiresFallback ? SKIP_THOUGHT_SIGNATURE : undefined);
					isFirstToolCall = false;
					/** @type {Record<string, unknown>} */
					const part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(model.compat?.supportsFunctionPartId ? { id } : {}),
						},
					};
					if (effective) part.thoughtSignature = effective;
					parts.push(part);
				}
			}
			if (parts.length === 0) continue;
			contents.push({ role: "model", parts });
		} else if (message.role === "toolResult" || message.role === "tool") {
			const blocks = asBlocks(message.content);
			const text = blocks
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");
			const images = supportsImages ? blocks.filter((block) => block.type === "image") : [];
			const omittedImages = !supportsImages && blocks.some((block) => block.type === "image");
			const responseValue = omittedImages
				? [text ? wellFormed(text) : "", NON_VISION_IMAGE_PLACEHOLDER].filter(Boolean).join("\n")
				: text
					? wellFormed(text)
					: images.length > 0
						? "(see attached image)"
						: "";
			const toolCallId = normalizeToolCallId(String(message.toolCallId ?? message.id ?? ""));
			const name = emittedToolCallNames.get(message.toolCallId) ?? message.toolName ?? message.name ?? "tool";
			/** @type {Record<string, unknown>} */
			const functionResponse = {
				name,
				response: message.isError ? { error: responseValue } : { output: responseValue },
				...(model.compat?.supportsFunctionPartId && toolCallId ? { id: toolCallId } : {}),
			};
			if (images.length > 0 && model.compat?.multimodalFunctionResponse) {
				functionResponse.parts = images.map((image) => convertImagePart(image));
			}
			const functionResponsePart = { functionResponse };
			const last = contents[contents.length - 1];
			if (last?.role === "user" && last.parts?.some((part) => part.functionResponse)) last.parts.push(functionResponsePart);
			else contents.push({ role: "user", parts: [functionResponsePart] });
			if (images.length > 0 && !model.compat?.multimodalFunctionResponse) {
				pendingToolImageParts.push({ text: "Tool result image:" }, ...images.map((image) => convertImagePart(image)));
			}
		}
	}
	flushPendingToolImages();
	return contents;
}

/**
 * @param {Array<{ name: string, description?: string, parameters?: unknown }>} tools
 */
export function convertTools(tools) {
	if (!tools || tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description || "",
				parameters: normalizeSchemaForCca(tool.parameters ?? { type: "object", properties: {} }),
			})),
		},
	];
}

/**
 * @param {Array<object>} messages
 */
function firstUserText(messages) {
	for (const message of messages ?? []) {
		if (message.role !== "user" && message.role !== "developer") continue;
		if (typeof message.content === "string") return message.content;
		const text = asBlocks(message.content).find((block) => block.type === "text")?.text;
		return text;
	}
	return undefined;
}

/**
 * Advance the per-conversation envelope. The first step is 2 when state starts empty.
 * @param {object} model
 * @param {Array<object>} messages
 * @param {string} wireModelId
 * @param {object | undefined} state
 * @param {{ now?: () => number, randomUUID?: () => string, randomSessionId?: () => string }} [ids]
 */
export function buildAntigravityRequestEnvelope(model, messages, wireModelId, state, ids = {}) {
	const uuid = ids.randomUUID ?? (() => crypto.randomUUID());
	const sessionIdOf = ids.randomSessionId ?? (() => randomSignedDecimalSessionId());
	const now = ids.now ?? Date.now;
	if (state) {
		if (!state.agentId) state.agentId = uuid();
		if (!state.trajectoryId) state.trajectoryId = uuid();
		if (!state.sessionId) state.sessionId = sessionIdOf();
		state.stepIndex = (state.stepIndex ?? 1) + 1;
	}
	const agentId = state?.agentId ?? uuid();
	const trajectoryId = state?.trajectoryId ?? uuid();
	const text = firstUserText(messages);
	const sessionId =
		state?.sessionId ?? (text && text.trim() ? deriveSignedDecimalFromHash(text) : sessionIdOf());
	const step = state?.stepIndex ?? 2;
	const requestId = `agent/${agentId}/${now()}/${trajectoryId}/${step}`;
	const isClaude = model.className === "anthropic";
	const profile = getAntigravityModelWireProfile(wireModelId);
	/** @type {Record<string, string>} */
	const labels = {};
	if (state?.lastExecutionId) labels.last_execution_id = state.lastExecutionId;
	labels.last_step_index = String(step - 1);
	if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum;
	labels.trajectory_id = trajectoryId;
	const usageLabel = model.compat?.antigravityUsageLabel ?? String(isClaude);
	labels.used_claude = usageLabel;
	labels.used_claude_conservative = usageLabel;
	return { sessionId, requestId, labels };
}

/**
 * @param {object} model
 * @param {{
 *   systemPrompt?: string | string[],
 *   messages?: object[],
 *   tools?: Array<{ name: string, description?: string, parameters?: unknown }>,
 *   toolChoice?: string | { mode?: string, allowedFunctionNames?: string[] },
 *   effort?: string,
 *   disableReasoning?: boolean,
 *   maxTokens?: number,
 *   temperature?: number,
 *   topP?: number,
 *   topK?: number,
 *   presencePenalty?: number,
 *   hideThinkingSummary?: boolean,
 *   thinkingBudgets?: Record<string, number>,
 * }} context
 * @param {string} projectId
 * @param {object} [state]
 * @param {{ now?: () => number, randomUUID?: () => string, randomSessionId?: () => string }} [ids]
 */
export function buildAntigravityRequest(model, context, projectId, state, ids) {
	const resolved = resolveThinking(model, context);
	const contents = convertMessages(model, context.messages ?? []);
	/** @type {Record<string, unknown>} */
	const generationConfig = {};
	if (context.temperature !== undefined) generationConfig.temperature = context.temperature;
	if (resolved.maxTokens !== undefined) generationConfig.maxOutputTokens = resolved.maxTokens;
	if (context.topP !== undefined) generationConfig.topP = context.topP;
	if (context.topK !== undefined) generationConfig.topK = context.topK;
	if (context.presencePenalty !== undefined) generationConfig.presencePenalty = context.presencePenalty;

	if (resolved.thinking.enabled && model.reasoning) {
		/** @type {Record<string, unknown>} */
		const thinkingConfig = { includeThoughts: !context.hideThinkingSummary };
		if (resolved.thinking.level !== undefined) thinkingConfig.thinkingLevel = resolved.thinking.level;
		else if (resolved.thinking.budgetTokens !== undefined) thinkingConfig.thinkingBudget = resolved.thinking.budgetTokens;
		generationConfig.thinkingConfig = thinkingConfig;
	} else if (resolved.thinking.suppress && model.reasoning) {
		/** @type {Record<string, unknown>} */
		const thinkingConfig = { includeThoughts: false };
		if ("level" in resolved.thinking.suppress) thinkingConfig.thinkingLevel = resolved.thinking.suppress.level;
		else thinkingConfig.thinkingBudget = resolved.thinking.suppress.budget;
		generationConfig.thinkingConfig = thinkingConfig;
	}

	const profile = getAntigravityModelWireProfile(resolved.wireModelId);
	if (profile) generationConfig.maxOutputTokens = profile.maxOutputTokens;

	/** @type {Record<string, unknown>} */
	const request = { contents };
	const prompts = normalizeSystemPrompts(context.systemPrompt);
	if (prompts.length > 0) {
		request.systemInstruction = { role: "user", parts: prompts.map((text) => ({ text })) };
	}
	const tools = model.supportsTools === false ? undefined : convertTools(context.tools ?? []);
	if (tools) {
		request.tools = tools;
		const choice = context.toolChoice;
		if (typeof choice === "string") {
			const mode = mapToolChoice(choice);
			if (mode !== "AUTO") request.toolConfig = { functionCallingConfig: { mode } };
		} else if (choice && Array.isArray(choice.allowedFunctionNames) && choice.allowedFunctionNames.length > 0) {
			request.toolConfig = {
				functionCallingConfig: { mode: "ANY", allowedFunctionNames: [...choice.allowedFunctionNames] },
			};
		}
		const mode = request.toolConfig?.functionCallingConfig?.mode;
		if (model.className !== "anthropic" && mode === "ANY") {
			contents.push({ role: "user", parts: [{ text: FORCED_TOOL_DIRECTIVE }] });
		}
		if (!request.toolConfig) request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
	}
	if (model.className === "anthropic" && model.compat?.antigravityClaudeToolMode) {
		request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
	}

	const envelope = buildAntigravityRequestEnvelope(model, context.messages ?? [], resolved.wireModelId, state, ids);
	request.labels = envelope.labels;
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
	request.sessionId = envelope.sessionId;
	return {
		resolved,
		body: {
			project: projectId,
			requestId: envelope.requestId,
			request,
			model: resolved.wireModelId,
			userAgent: "antigravity",
			requestType: "agent",
		},
	};
}
