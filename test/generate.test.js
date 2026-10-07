import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { listAccounts } from "../src/accounts.js";
import { generateAntigravity, listAntigravityModels, selectAntigravityEndpoints } from "../src/generate.js";
import {
	ANTIGRAVITY_DAILY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
	catalogAntigravityModel,
	modelsFromDiscoveryPayload,
} from "../src/models.js";
import { loadCredentials } from "../src/store.js";
import { loadSession } from "../src/session.js";

function credential(overrides = {}) {
	return {
		type: "oauth",
		provider: "google-antigravity",
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 3_600_000,
		email: "user@example.com",
		projectId: "project-123",
		...overrides,
	};
}

function models() {
	return modelsFromDiscoveryPayload(
		{
			models: {
				"gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro", supportsThinking: true },
				"gemini-pro-agent": { displayName: "Gemini Pro Agent", supportsThinking: true },
				"claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", supportsThinking: true },
			},
		},
		ANTIGRAVITY_DAILY_ENDPOINT,
	).models;
}

function sse(events, status = 200) {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

function textEvent(text, extra = {}) {
	return {
		response: {
			candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
			responseId: "resp-1",
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
			...extra,
		},
	};
}

describe("Antigravity generate", () => {
	it("orders endpoints from the last good host, then daily, then sandbox", () => {
		assert.deepEqual(selectAntigravityEndpoints("production"), {
			endpoints: [ANTIGRAVITY_DAILY_ENDPOINT],
			clearLastGood: true,
		});
		assert.deepEqual(selectAntigravityEndpoints("auto", undefined, ANTIGRAVITY_SANDBOX_ENDPOINT).endpoints, [
			ANTIGRAVITY_SANDBOX_ENDPOINT,
			ANTIGRAVITY_DAILY_ENDPOINT,
		]);
	});

	it("posts streamGenerateContent with the routed wire model", async () => {
		const calls = [];
		const fetchImpl = async (url, init) => {
			const href = String(url);
			calls.push({ href, init });
			if (href.includes("manifest")) return new Response("version: 2.8.0\n");
			assert.equal(href, `${ANTIGRAVITY_DAILY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`);
			assert.equal(init.headers.Authorization, "Bearer access-token");
			assert.equal(init.headers.Accept, "text/event-stream");
			const body = JSON.parse(init.body);
			assert.equal(body.project, "project-123");
			assert.equal(body.model, "gemini-pro-agent");
			assert.equal(body.userAgent, "antigravity");
			assert.equal(body.requestType, "agent");
			return sse([textEvent("hello")]);
		};
		const deltas = [];
		const result = await generateAntigravity({
			credential: credential(),
			models: models(),
			model: "gemini-3.1-pro",
			effort: "high",
			prompt: "Say hello",
			fetch: fetchImpl,
			sleep: async () => {
				throw new Error("should not retry");
			},
			onText: (delta) => deltas.push(delta),
		});
		assert.equal(result.text, "hello");
		assert.deepEqual(deltas, ["hello"]);
		assert.equal(result.wireModelId, "gemini-pro-agent");
		assert.equal(result.stopReason, "stop");
		assert.equal(result.usage.input, 10);
		assert.equal(result.usage.output, 2);
		assert.equal(result.endpoint, ANTIGRAVITY_DAILY_ENDPOINT);
		assert.equal(calls.some((call) => call.href.includes("streamGenerateContent")), true);
	});

	it("calls gemini-3.8-flash like omp, without listing models, and continues the session", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-flash-"));
		const sessionPath = path.join(dir, "session.json");
		const urls = [];
		/** @type {object[]} */
		const bodies = [];
		const fetchImpl = async (url, init) => {
			const href = String(url);
			urls.push(href);
			if (href.includes("manifest")) return new Response("version: 2.8.0\n");
			bodies.push(JSON.parse(init.body));
			return sse([textEvent("ok", { responseId: `resp-${bodies.length}` })]);
		};
		const model = catalogAntigravityModel("gemini-3.8-flash");
		const first = await generateAntigravity({
			credential: credential(),
			models: [model],
			model: "gemini-3.8-flash",
			effort: "medium",
			prompt: "Hello",
			fetch: fetchImpl,
			sessionPath,
			sleep: async () => {
				throw new Error("should not retry");
			},
		});
		const second = await generateAntigravity({
			credential: credential(),
			models: [model],
			model: "gemini-3.8-flash",
			effort: "medium",
			prompt: "Again",
			fetch: fetchImpl,
			sessionPath,
			sleep: async () => {
				throw new Error("should not retry");
			},
		});
		assert.equal(first.wireModelId, "gemini-3.8-flash-medium");
		assert.equal(second.wireModelId, "gemini-3.8-flash-medium");
		assert.equal(urls.some((href) => href.includes("fetchAvailableModels")), false);
		assert.equal(bodies[0].model, "gemini-3.8-flash-medium");
		assert.equal(bodies[0].userAgent, "antigravity");
		assert.equal(bodies[0].requestType, "agent");
		assert.equal(bodies[0].request.generationConfig.thinkingConfig.thinkingLevel, "MEDIUM");
		assert.equal(bodies[0].request.labels.last_execution_id, undefined);
		assert.equal(bodies[1].request.labels.last_execution_id, "resp-1");
		assert.equal(bodies[1].request.sessionId, bodies[0].request.sessionId);
		assert.equal(loadSession(sessionPath).stepIndex, 3);
	});

	it("fails over from a transient daily response to sandbox and remembers it", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-gen-"));
		const sessionPath = path.join(dir, "session.json");
		const urls = [];
		const fetchImpl = async (url) => {
			const href = String(url);
			urls.push(href);
			if (href.includes("manifest")) return new Response("version: 2.8.0\n");
			if (href.startsWith(ANTIGRAVITY_DAILY_ENDPOINT)) return new Response("unavailable", { status: 503 });
			return sse([textEvent("from-sandbox")]);
		};
		const result = await generateAntigravity({
			credential: credential(),
			models: models(),
			prompt: "hi",
			fetch: fetchImpl,
			sessionPath,
			sleep: async () => {},
		});
		assert.equal(result.text, "from-sandbox");
		assert.equal(result.endpoint, ANTIGRAVITY_SANDBOX_ENDPOINT);
		assert.equal(loadSession(sessionPath).lastGoodEndpoint, ANTIGRAVITY_SANDBOX_ENDPOINT);
		assert.equal(loadSession(sessionPath).lastExecutionId, "resp-1");
		assert.equal(loadSession(sessionPath).stepIndex, 2);
		assert.equal(urls.filter((href) => href.includes("streamGenerateContent")).length, 2);
	});

	it("refreshes an expired access token before the call and saves it", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-refresh-"));
		const file = path.join(dir, "credentials.json");
		const stored = credential({ expires: Date.now() - 1000 });
		fs.writeFileSync(file, `${JSON.stringify(stored)}\n`);
		const fetchImpl = async (url, init) => {
			const href = String(url);
			if (href.includes("manifest")) return new Response("version: 2.8.0\n");
			if (href.includes("/token")) {
				const params = new URLSearchParams(String(init.body));
				assert.equal(params.get("grant_type"), "refresh_token");
				assert.equal(params.get("refresh_token"), "refresh-token");
				return Response.json({ access_token: "new-access", expires_in: 3600 });
			}
			assert.equal(init.headers.Authorization, "Bearer new-access");
			return sse([textEvent("fresh")]);
		};
		const result = await generateAntigravity({
			credential: stored,
			credentialPath: file,
			models: models(),
			prompt: "hi",
			fetch: fetchImpl,
			sleep: async () => {},
		});
		assert.equal(result.text, "fresh");
		assert.equal(loadCredentials(file).access, "new-access");
		assert.equal(loadCredentials(file).projectId, "project-123");
		assert.equal(loadCredentials(file).refresh, "refresh-token");
		const accounts = listAccounts({
			credentialPath: file,
			accountsDir: path.join(dir, "accounts"),
			indexPath: path.join(dir, "accounts.json"),
		});
		assert.equal(accounts.length, 1);
		assert.equal(accounts[0].email, "user@example.com");
		assert.ok(accounts[0].expires > Date.now());
	});

	it("retries a first-event timeout with a new abort signal", async () => {
		let streamCalls = 0;
		const fetchImpl = async (url, init) => {
			const href = String(url);
			if (href.includes("manifest")) return new Response("version: 2.8.0\n");
			streamCalls += 1;
			if (streamCalls === 1) {
				await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("timed out waiting for abort")), 2000);
					const onAbort = () => {
						clearTimeout(timer);
						reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					};
					if (init.signal?.aborted) onAbort();
					else init.signal?.addEventListener("abort", onAbort, { once: true });
				});
			}
			if (init.signal?.aborted) throw Object.assign(new Error("signal was already aborted"), { name: "AbortError" });
			return sse([textEvent("retried")]);
		};
		const result = await generateAntigravity({
			credential: credential(),
			models: models(),
			prompt: "hi",
			endpointMode: "production",
			firstEventTimeoutMs: 30,
			maxRetryDelayMs: 0,
			sleep: async () => {},
			fetch: fetchImpl,
		});
		assert.equal(result.text, "retried");
		assert.equal(streamCalls, 2);
	});

	it("rewrites VALIDATION_REQUIRED into the account verification message", async () => {
		const fetchImpl = async (url) => {
			if (String(url).includes("manifest")) return new Response("version: 2.8.0\n");
			return new Response(
				JSON.stringify({
					error: { details: [{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: "https://example.com/verify" } }] },
				}),
				{ status: 403 },
			);
		};
		await assert.rejects(
			() =>
				generateAntigravity({
					credential: credential(),
					models: models(),
					model: "gemini-3.1-pro",
					prompt: "hi",
					endpointMode: "production",
					fetch: fetchImpl,
					sleep: async () => {},
				}),
			/Account verification required for user@example.com\. Visit https:\/\/example.com\/verify to continue, then retry your request\./,
		);
	});

	it("retries an empty STOP and then returns the next response", async () => {
		let streams = 0;
		let sleeps = 0;
		const fetchImpl = async (url) => {
			if (String(url).includes("manifest")) return new Response("version: 2.8.0\n");
			streams += 1;
			if (streams === 1) return sse([textEvent(" ")]);
			return sse([
				{
					response: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ thought: true, text: "plan" }, { functionCall: { name: "lookup", args: { q: "x" } } }],
								},
								finishReason: "STOP",
							},
						],
						responseId: "resp-2",
					},
				},
			]);
		};
		const result = await generateAntigravity({
			credential: credential(),
			models: models(),
			prompt: "hi",
			endpointMode: "production",
			fetch: fetchImpl,
			sleep: async () => {
				sleeps += 1;
			},
		});
		assert.equal(sleeps, 1);
		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.toolCalls[0].name, "lookup");
		assert.equal(result.toolCalls[0].id.startsWith("lookup_"), true);
		assert.equal(result.thinking, "plan");
		assert.equal(result.responseId, "resp-2");
	});

	it("sends the Claude thinking beta header", async () => {
		const fetchImpl = async (url, init) => {
			if (String(url).includes("manifest")) return new Response("version: 2.8.0\n");
			assert.equal(init.headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
			const body = JSON.parse(init.body);
			assert.equal(body.model, "claude-sonnet-4-6");
			assert.equal(body.request.toolConfig.functionCallingConfig.mode, "VALIDATED");
			return sse([textEvent("ok")]);
		};
		const result = await generateAntigravity({
			credential: credential(),
			models: models(),
			model: "claude-sonnet-4-6",
			effort: "low",
			prompt: "hi",
			endpointMode: "production",
			fetch: fetchImpl,
			sleep: async () => {},
		});
		assert.equal(result.text, "ok");
	});

	it("lists models with the bearer token from the saved login", async () => {
		const fetchImpl = async (url, init) => {
			const href = String(url);
			if (href.includes("manifest")) return new Response("version: 2.8.0\n");
			assert.equal(init.headers.Authorization, "Bearer access-token");
			return Response.json({
				models: { "gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro", supportsThinking: true } },
			});
		};
		const listed = await listAntigravityModels({ credential: credential(), endpoint: ANTIGRAVITY_DAILY_ENDPOINT, fetch: fetchImpl });
		assert.equal(listed.models[0].id, "gemini-3.1-pro");
		assert.equal(listed.credential.access, "access-token");
	});
});
