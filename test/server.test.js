import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createApiKey, resolveServerApiKey } from "../src/api-key.js";
import { normalizeChatRequest, SERVER_MODEL_ID } from "../src/chat.js";
import { createChatServer, listen } from "../src/server.js";

/**
 * @param {typeof import("../src/generate.js").generateAntigravity} generate
 * @param {{ apiKey?: string, loadCredential?: () => object }} [options]
 */
async function withServer(generate, options, run) {
	const server = createChatServer({
		apiKey: options?.apiKey ?? "test-key",
		credentialPath: options?.credentialPath ?? path.join(os.tmpdir(), "antigravity-provider-test-credentials.json"),
		apiKeysPath: options?.apiKeysPath,
		loadCredential: options?.loadCredential ?? (() => ({ access: "token", refresh: "refresh", projectId: "project-1" })),
		generate,
	});
	const address = await listen(server, { host: "127.0.0.1", port: 0 });
	try {
		return await run(address.port);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
	}
}

/**
 * @param {number} port
 * @param {object | string} body
 * @param {{ auth?: string | null, headers?: Record<string, string>, path?: string }} [options]
 */
function post(port, body, options = {}) {
	const payload = typeof body === "string" ? body : JSON.stringify(body);
	/** @type {Record<string, string | number>} */
	const headers = {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		...(options.headers ?? {}),
	};
	if (options.auth !== null) headers.Authorization = `Bearer ${options.auth ?? "test-key"}`;
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: options.path ?? "/v1/chat/completions",
				method: "POST",
				headers,
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					resolve({
						status: res.statusCode,
						type: res.headers["content-type"],
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

/**
 * @param {number} port
 * @param {string} path
 * @param {{ auth?: string | null, headers?: Record<string, string> }} [options]
 */
function get(port, path, options = {}) {
	/** @type {Record<string, string>} */
	const headers = { ...(options.headers ?? {}) };
	if (options.auth !== null) headers.Authorization = `Bearer ${options.auth ?? "test-key"}`;
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "GET",
				headers,
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					resolve({
						status: res.statusCode,
						type: res.headers["content-type"],
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function result(options) {
	return {
		text: "Hello",
		thinking: "plan",
		toolCalls: [{ id: "call_1", name: "lookup", arguments: { q: "x" } }],
		stopReason: "stop",
		usage: { input: 3, output: 4, totalTokens: 7 },
		effort: options.effort,
		wireModelId: "gemini-3.8-flash-medium",
		responseId: "resp-1",
	};
}

describe("chat request", () => {
	it("forces gemini-3.8-flash and defaults effort to medium", () => {
		const chat = normalizeChatRequest({
			model: "gemini-3.1-pro",
			apiKey: "secret",
			messages: [
				{ role: "system", content: "Be brief" },
				{ role: "user", content: "Hi" },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "lookup",
						description: "Find a record",
						parameters: { type: "object", properties: { q: { type: "string" } } },
					},
				},
			],
			tool_choice: "required",
		});
		assert.equal(chat.model, SERVER_MODEL_ID);
		assert.equal(chat.model, "gemini-3.8-flash");
		assert.equal(chat.effort, "medium");
		assert.equal(chat.systemPrompt, "Be brief");
		assert.deepEqual(chat.messages, [{ role: "user", content: "Hi" }]);
		assert.equal(chat.tools[0].name, "lookup");
		assert.equal(chat.tools[0].description, "Find a record");
		assert.equal(chat.toolChoice, "any");
		assert.equal("apiKey" in chat, false);
		const named = normalizeChatRequest({
			messages: [{ role: "user", content: "Hi" }],
			tool_choice: { type: "function", function: { name: "lookup" } },
		});
		assert.deepEqual(named.toolChoice, { allowedFunctionNames: ["lookup"] });
	});

	it("keeps native tool calls and maps an OpenAI tool result", () => {
		const chat = normalizeChatRequest({
			effort: "high",
			prompt: "continue",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "x" } }],
				},
				{ role: "tool", tool_call_id: "call_1", name: "lookup", content: "found" },
			],
		});
		assert.equal(chat.effort, "high");
		assert.equal(chat.prompt, "continue");
		assert.equal(chat.messages[0].content[0].type, "toolCall");
		assert.equal(chat.messages[1].toolCallId, "call_1");
		assert.equal(chat.messages[1].content, "found");
	});
});

describe("chat server", () => {
	it("rejects a missing or wrong API key", async () => {
		const calls = [];
		await withServer(
			async (options) => {
				calls.push(options);
				return result(options);
			},
			{},
			async (port) => {
				const missing = await post(port, { messages: [{ role: "user", content: "Hi" }] }, { auth: null });
				assert.equal(missing.status, 401);
				const wrong = await post(port, { messages: [{ role: "user", content: "Hi" }] }, { auth: "nope" });
				assert.equal(wrong.status, 401);
				const bodyKey = await post(
					port,
					{ apiKey: "test-key", messages: [{ role: "user", content: "Hi" }] },
					{ auth: null },
				);
				assert.equal(bodyKey.status, 200);
			},
		);
		assert.equal(calls.length, 1);
	});

	it("forwards prompts and tools to gemini-3.8-flash at medium effort", async () => {
		/** @type {object[]} */
		const calls = [];
		const response = await withServer(
			async (options) => {
				calls.push(options);
				options.onText?.("Hello");
				return result(options);
			},
			{},
			(port) =>
				post(port, {
					messages: [
						{ role: "system", content: "Be brief" },
						{
							role: "user",
							content: [
								{ type: "text", text: "Look up x" },
								{ type: "image_url", image_url: { url: "data:image/png;base64,aaaa" } },
							],
						},
						{
							role: "assistant",
							content: null,
							tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
						},
					],
					tools: [{ name: "lookup", description: "Find", parameters: { type: "object", properties: {} } }],
					temperature: 0.2,
					max_tokens: 128,
				}),
		);
		assert.equal(response.status, 200);
		const body = JSON.parse(response.body);
		assert.equal(body.model, "gemini-3.8-flash");
		assert.equal(body.effort, "medium");
		assert.equal(body.wireModelId, "gemini-3.8-flash-medium");
		assert.equal(body.choices[0].message.content, "Hello");
		assert.equal(body.choices[0].message.tool_calls[0].function.name, "lookup");
		assert.equal(body.choices[0].finish_reason, "tool_calls");
		assert.equal(body.toolCalls[0].id, "call_1");
		assert.equal(body.thinking, "plan");
		const forwarded = calls[0];
		assert.equal(forwarded.model, "gemini-3.8-flash");
		assert.equal(forwarded.effort, "medium");
		assert.equal(forwarded.systemPrompt, "Be brief");
		assert.equal(forwarded.newSession, undefined);
		assert.equal(forwarded.save, undefined);
		assert.equal(forwarded.models[0].id, "gemini-3.8-flash");
		assert.equal(forwarded.models[0].thinking.effortRouting.medium, "gemini-3.8-flash-medium");
		assert.match(forwarded.sessionPath, /sessions[\\/][a-f0-9]{32}\.json$/);
		assert.equal(forwarded.apiKey, undefined);
		assert.equal(forwarded.tools[0].name, "lookup");
		assert.equal(forwarded.temperature, 0.2);
		assert.equal(forwarded.maxTokens, 128);
		assert.equal(forwarded.messages[0].content[0].text, "Look up x");
		assert.equal(forwarded.messages[0].content[1].mimeType, "image/png");
		assert.equal(forwarded.messages[0].content[1].data, "aaaa");
		assert.equal(forwarded.messages[1].content[0].type, "toolCall");
		assert.deepEqual(forwarded.messages[1].content[0].arguments, { q: "x" });
	});

	it("rejects a remote image URL before calling the model", async () => {
		const response = await withServer(
			async () => {
				throw new Error("generate should not run");
			},
			{},
			(port) =>
				post(port, {
					messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.jpg" } }] }],
				}),
		);
		assert.equal(response.status, 400);
		assert.match(response.body, /data URLs/);
	});

	it("gives each API key its own session file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-session-test-"));
		const storePath = path.join(dir, "api-keys.json");
		createApiKey({ name: "A", key: "key-a" }, { storePath });
		createApiKey({ name: "B", key: "key-b" }, { storePath });
		/** @type {string[]} */
		const sessions = [];
		try {
			await withServer(
				async (options) => {
					sessions.push(options.sessionPath);
					return result(options);
				},
				{ apiKeysPath: storePath, credentialPath: path.join(dir, "credentials.json") },
				async (port) => {
					const first = await post(port, { prompt: "Hi" }, { auth: "key-a" });
					const second = await post(port, { prompt: "Hi" }, { auth: "key-b" });
					assert.equal(first.status, 200);
					assert.equal(second.status, 200);
				},
			);
			assert.equal(sessions.length, 2);
			assert.notEqual(sessions[0], sessions[1]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("streams text and tool calls", async () => {
		const response = await withServer(
			async (options) => {
				options.onText?.("Hel");
				options.onText?.("lo");
				return result(options);
			},
			{},
			(port) => post(port, { stream: true, effort: "low", prompt: "Hi", stream_options: { include_usage: true } }),
		);
		assert.equal(response.status, 200);
		assert.match(response.type, /text\/event-stream/);
		assert.match(response.body, /"content":"Hel"/);
		assert.match(response.body, /"content":"lo"/);
		assert.match(response.body, /"name":"lookup"/);
		assert.match(response.body, /"usage":\{"prompt_tokens":3/);
		assert.match(response.body, /data: \[DONE\]/);
	});

	it("returns 400 for an unknown effort and does not call the model", async () => {
		let called = false;
		const response = await withServer(
			async () => {
				called = true;
				throw new Error("should not be called");
			},
			{},
			(port) => post(port, { effort: "turbo", messages: [{ role: "user", content: "Hi" }] }),
		);
		assert.equal(response.status, 400);
		assert.equal(called, false);
		assert.match(response.body, /Invalid effort/);
	});

	it("reports a missing login as 503", async () => {
		const response = await withServer(async () => result({}), {
			loadCredential() {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			},
		}, (port) => post(port, { prompt: "Hi" }));
		assert.equal(response.status, 503);
		assert.match(response.body, /Not logged in/);
	});

	it("answers health without an API key", async () => {
		await withServer(async (options) => result(options), {}, async (port) => {
			const response = await new Promise((resolve, reject) => {
				http.get({ hostname: "127.0.0.1", port, path: "/health" }, (res) => {
					const chunks = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
				}).on("error", reject);
			});
			assert.equal(response.status, 200);
			assert.equal(JSON.parse(response.body).model, "gemini-3.8-flash");
		});
	});

	it("rejects GET /v1/models with a missing or wrong API key", async () => {
		await withServer(async (options) => result(options), {}, async (port) => {
			const missing = await get(port, "/v1/models", { auth: null });
			assert.equal(missing.status, 401);
			const wrong = await get(port, "/v1/models", { auth: "wrong" });
			assert.equal(wrong.status, 401);
		});
	});

	it("returns list containing only gemini-3.8-flash for GET /v1/models", async () => {
		await withServer(async (options) => result(options), {}, async (port) => {
			const response = await get(port, "/v1/models");
			assert.equal(response.status, 200);
			const body = JSON.parse(response.body);
			assert.equal(body.object, "list");
			assert.equal(body.data.length, 1);
			assert.equal(body.data[0].id, "gemini-3.8-flash");
			assert.equal(body.data[0].object, "model");

			const altResponse = await get(port, "/models");
			assert.equal(altResponse.status, 200);
			assert.deepEqual(JSON.parse(altResponse.body), body);
		});
	});

	it("returns model object for GET /v1/models/gemini-3.8-flash and 404 for unknown models", async () => {
		await withServer(async (options) => result(options), {}, async (port) => {
			const ok = await get(port, "/v1/models/gemini-3.8-flash");
			assert.equal(ok.status, 200);
			const body = JSON.parse(ok.body);
			assert.equal(body.id, "gemini-3.8-flash");
			assert.equal(body.object, "model");

			const notFound = await get(port, "/v1/models/gpt-4");
			assert.equal(notFound.status, 404);
		});
	});
});

describe("server API key file", () => {
	it("creates a key file when none is configured", () => {
		const file = path.join(os.tmpdir(), `antigravity-api-key-${process.pid}-${Date.now()}`);
		fs.rmSync(file, { force: true });
		const created = resolveServerApiKey({ file });
		try {
			assert.equal(created.created, true);
			assert.equal(created.key.length > 20, true);
			const again = resolveServerApiKey({ file });
			assert.equal(again.created, false);
			assert.equal(again.key, created.key);
			const fromFlag = resolveServerApiKey({ key: "explicit", file });
			assert.equal(fromFlag.key, "explicit");
			assert.equal(fromFlag.created, false);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});
});
