/**
 * Map an HTTP chat request onto generateAntigravity.
 * The server model is always gemini-3.8-flash. Effort defaults to medium.
 * OpenAI chat-completions bodies and the native message shape are both accepted.
 */
import crypto from "node:crypto";

export const SERVER_MODEL_ID = "gemini-3.8-flash";
export const DEFAULT_SERVER_EFFORT = "medium";

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class ChatRequestError extends Error {
	/**
	 * @param {string} message
	 * @param {number} [status]
	 */
	constructor(message, status = 400) {
		super(message);
		this.name = "ChatRequestError";
		this.status = status;
	}
}

/**
 * @param {unknown} value
 */
export function assertEffort(value) {
	if (value === undefined || value === null || value === "") return DEFAULT_SERVER_EFFORT;
	if (typeof value !== "string" || !EFFORTS.has(value)) {
		throw new ChatRequestError(`Invalid effort "${String(value)}". Use off, minimal, low, medium, high, xhigh, or max.`);
	}
	return value;
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {Record<string, unknown> | undefined} body
 */
export function readRequestApiKey(req, body) {
	const header = req.headers?.authorization;
	if (typeof header === "string") {
		const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
		if (match?.[1]) return match[1];
	}
	const headerKey = req.headers?.["x-api-key"];
	if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim();
	if (typeof body?.apiKey === "string" && body.apiKey) return body.apiKey;
	if (typeof body?.api_key === "string" && body.api_key) return body.api_key;
	return "";
}

/**
 * @param {unknown} content
 */
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (part.type === "text" || part.type === "input_text") return part.text ?? "";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * @param {string} url
 */
function imageFromUrl(url) {
	const data = /^data:([^;,]+)?(?:;base64)?,([\s\S]*)$/.exec(url);
	if (data) return { type: "image", mimeType: data[1] || "image/png", data: data[2] ?? "" };
	return { type: "image", url, mimeType: "image/png" };
}

/**
 * @param {unknown} content
 */
function mapUserContent(content) {
	if (typeof content === "string" || content == null) return content ?? "";
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (!part || typeof part !== "object") return { type: "text", text: "" };
		if (part.type === "image_url") {
			const url = part.image_url?.url ?? part.url ?? "";
			return imageFromUrl(String(url));
		}
		if (part.type === "input_text") return { type: "text", text: part.text ?? "" };
		return part;
	});
}

/**
 * @param {object} call
 */
function mapOpenAiToolCall(call) {
	const fn = call.function ?? call;
	let args = fn.arguments ?? call.arguments ?? {};
	if (typeof args === "string") {
		try {
			args = args ? JSON.parse(args) : {};
		} catch {
			args = {};
		}
	}
	return { type: "toolCall", id: call.id, name: fn.name ?? call.name ?? "", arguments: args };
}

/**
 * @param {object} message
 * @returns {object | { kind: "system", text: string } | null}
 */
function mapMessage(message) {
	if (!message || typeof message !== "object") return null;
	if (message.role === "system") return { kind: "system", text: textOf(message.content) };
	if (message.role === "user" || message.role === "developer") {
		return { role: message.role === "developer" ? "developer" : "user", content: mapUserContent(message.content) };
	}
	if (message.role === "assistant" || message.role === "model") {
		const native = Array.isArray(message.content);
		/** @type {object[]} */
		const blocks = native ? [...message.content] : [];
		if (!native) {
			const text = textOf(message.content);
			if (text) blocks.push({ type: "text", text });
		}
		for (const call of message.tool_calls ?? []) blocks.push(mapOpenAiToolCall(call));
		if (!native && blocks.length === 0) return { role: "assistant", content: message.content ?? "" };
		return { role: "assistant", content: blocks, provider: message.provider, model: message.model };
	}
	if (message.role === "tool" || message.role === "toolResult") {
		return {
			role: message.role === "toolResult" ? "toolResult" : "tool",
			toolCallId: message.tool_call_id ?? message.toolCallId ?? message.id,
			toolName: message.name ?? message.toolName,
			isError: message.isError === true,
			content: typeof message.content === "string" || message.content == null ? (message.content ?? "") : mapUserContent(message.content),
		};
	}
	return null;
}

/**
 * @param {unknown} tools
 */
function mapTools(tools) {
	if (tools === undefined) return undefined;
	if (!Array.isArray(tools)) throw new ChatRequestError("tools must be an array");
	return tools.map((tool) => {
		if (!tool || typeof tool !== "object") throw new ChatRequestError("Each tool must be an object");
		const fn = tool.type === "function" && tool.function ? tool.function : tool;
		if (!fn.name || typeof fn.name !== "string") throw new ChatRequestError("Each tool needs a name");
		return {
			name: fn.name,
			description: fn.description ?? "",
			parameters: fn.parameters ?? fn.parametersJsonSchema ?? { type: "object", properties: {} },
		};
	});
}

/**
 * @param {unknown} choice
 */
function mapToolChoice(choice) {
	if (choice === undefined || choice === null) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		throw new ChatRequestError(`Invalid tool_choice "${choice}"`);
	}
	if (typeof choice === "object") {
		if (Array.isArray(choice.allowedFunctionNames)) return { allowedFunctionNames: [...choice.allowedFunctionNames] };
		const name = choice.function?.name ?? choice.name;
		if (typeof name === "string" && name) return { allowedFunctionNames: [name] };
	}
	throw new ChatRequestError("Invalid tool_choice");
}

/**
 * @param {number | undefined} value
 * @param {string} label
 */
function optionalNumber(value, label) {
	if (value === undefined || value === null || value === "") return undefined;
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(number)) throw new ChatRequestError(`Invalid ${label}`);
	return number;
}

/**
 * Turn a chat request into generateAntigravity options.
 * The model id is forced. apiKey is not copied through.
 * @param {Record<string, unknown>} body
 */
export function normalizeChatRequest(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatRequestError("Request body must be a JSON object");
	const effort = assertEffort(body.effort ?? body.reasoning_effort);
	/** @type {string[]} */
	const systemParts = [];
	const directSystem = body.systemPrompt ?? body.system;
	if (typeof directSystem === "string" && directSystem) systemParts.push(directSystem);
	else if (Array.isArray(directSystem)) systemParts.push(...directSystem.filter((part) => typeof part === "string"));
	/** @type {object[]} */
	const messages = [];
	if (body.messages !== undefined && !Array.isArray(body.messages)) throw new ChatRequestError("messages must be an array");
	for (const message of body.messages ?? []) {
		const mapped = mapMessage(message);
		if (!mapped) continue;
		if (mapped.kind === "system") {
			if (mapped.text) systemParts.push(mapped.text);
			continue;
		}
		messages.push(mapped);
	}
	const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
	if (messages.length === 0 && !prompt) throw new ChatRequestError("Pass messages or a prompt");
	const maxTokens = optionalNumber(body.maxTokens ?? body.max_tokens, "max_tokens");
	if (maxTokens !== undefined && maxTokens <= 0) throw new ChatRequestError("Invalid max_tokens");
	return {
		model: SERVER_MODEL_ID,
		effort,
		systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
		messages,
		prompt,
		tools: mapTools(body.tools),
		toolChoice: mapToolChoice(body.tool_choice ?? body.toolChoice),
		maxTokens,
		temperature: optionalNumber(body.temperature, "temperature"),
		topP: optionalNumber(body.topP ?? body.top_p, "top_p"),
		topK: optionalNumber(body.topK ?? body.top_k, "top_k"),
		presencePenalty: optionalNumber(body.presencePenalty ?? body.presence_penalty, "presence_penalty"),
		stream: body.stream === true,
	};
}

/**
 * @param {{
 *   text?: string,
 *   thinking?: string,
 *   toolCalls?: object[],
 *   stopReason?: string,
 *   usage?: { input?: number, output?: number, totalTokens?: number },
 *   effort?: string,
 *   wireModelId?: string,
 *   responseId?: string,
 * }} result
 */
export function formatChatCompletion(result) {
	const toolCalls = (result.toolCalls ?? []).map((call) => ({
		id: call.id,
		type: "function",
		function: {
			name: call.name,
			arguments: JSON.stringify(call.arguments ?? {}),
		},
	}));
	const finishReason = result.stopReason === "length" ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop";
	return {
		id: result.responseId ? `chatcmpl-${result.responseId}` : `chatcmpl-${crypto.randomUUID()}`,
		object: "chat.completion",
		model: SERVER_MODEL_ID,
		effort: result.effort ?? DEFAULT_SERVER_EFFORT,
		wireModelId: result.wireModelId,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: result.text ? result.text : null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				},
				finish_reason: finishReason,
			},
		],
		usage: {
			prompt_tokens: result.usage?.input ?? 0,
			completion_tokens: result.usage?.output ?? 0,
			total_tokens: result.usage?.totalTokens ?? 0,
		},
		text: result.text ?? "",
		thinking: result.thinking ?? "",
		toolCalls: result.toolCalls ?? [],
		stopReason: result.stopReason,
	};
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} delta
 * @param {string | null} finishReason
 */
export function formatChatChunk(id, delta, finishReason) {
	return {
		id,
		object: "chat.completion.chunk",
		model: SERVER_MODEL_ID,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}
