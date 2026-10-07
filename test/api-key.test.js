import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	createApiKey,
	deleteApiKey,
	findApiKey,
	generateApiKey,
	listApiKeys,
	loadApiKeysStore,
	recordKeyUsage,
	resetKeyUsage,
	updateApiKey,
	validateApiKey,
} from "../src/api-key.js";
import { createChatServer, listen } from "../src/server.js";

function setupKeyEnv() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-keys-test-"));
	const storePath = path.join(dir, "api-keys.json");
	const singleKeyFile = path.join(dir, "api-key");
	const credentialPath = path.join(dir, "credentials.json");
	return { dir, storePath, singleKeyFile, credentialPath };
}

describe("api-key CRUD and management", () => {
	it("generates random keys with prefix", () => {
		const k1 = generateApiKey();
		const k2 = generateApiKey();
		assert.match(k1, /^ag-/);
		assert.notEqual(k1, k2);
	});

	it("creates, reads, and lists API keys", () => {
		const env = setupKeyEnv();
		try {
			const k1 = createApiKey({ name: "Dev Key", key: "ag-test-123" }, env);
			assert.equal(k1.key, "ag-test-123");
			assert.equal(k1.name, "Dev Key");
			assert.equal(k1.enabled, true);
			assert.deepEqual(k1.usage, { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });

			const k2 = createApiKey({ name: "Prod Key" }, env);
			assert.match(k2.key, /^ag-/);

			const list = listApiKeys(env);
			assert.equal(list.length, 2);
			assert.equal(list.some((k) => k.name === "Dev Key"), true);
			assert.equal(list.some((k) => k.name === "Prod Key"), true);

			// Duplicate key throws
			assert.throws(() => createApiKey({ key: "ag-test-123" }, env));
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("edits an API key name and enabled status", () => {
		const env = setupKeyEnv();
		try {
			createApiKey({ name: "Initial", key: "ag-my-key" }, env);

			// Edit name
			const updated1 = updateApiKey("ag-my-key", { name: "Renamed" }, env);
			assert.equal(updated1.name, "Renamed");
			assert.equal(updated1.enabled, true);

			// Disable key
			const updated2 = updateApiKey("Renamed", { enabled: false }, env);
			assert.equal(updated2.enabled, false);

			const found = findApiKey("ag-my-key", env);
			assert.equal(found.enabled, false);
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("deletes an API key", () => {
		const env = setupKeyEnv();
		try {
			createApiKey({ name: "To Delete", key: "ag-del" }, env);
			assert.equal(listApiKeys(env).length, 1);

			deleteApiKey("To Delete", env);
			assert.equal(listApiKeys(env).length, 0);
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("validates keys correctly including disabled status", () => {
		const env = setupKeyEnv();
		try {
			createApiKey({ name: "Active", key: "ag-active" }, env);
			createApiKey({ name: "Inactive", key: "ag-inactive", enabled: false }, env);

			// Active key validates
			const res1 = validateApiKey("ag-active", { storePath: env.storePath });
			assert.equal(res1.valid, true);

			// Disabled key fails
			const res2 = validateApiKey("ag-inactive", { storePath: env.storePath });
			assert.equal(res2.valid, false);

			// Unknown key fails
			const res3 = validateApiKey("ag-unknown", { storePath: env.storePath });
			assert.equal(res3.valid, false);

			// Master key validates
			const res4 = validateApiKey("master-secret", { masterKey: "master-secret", storePath: env.storePath });
			assert.equal(res4.valid, true);

			// If master key is present in store and disabled, it fails
			createApiKey({ name: "Master Record", key: "master-disabled", enabled: false }, env);
			const res5 = validateApiKey("master-disabled", { masterKey: "master-disabled", storePath: env.storePath });
			assert.equal(res5.valid, false);
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("records request count and token usage per key", () => {
		const env = setupKeyEnv();
		try {
			createApiKey({ name: "Usage Key", key: "ag-usage" }, env);

			// Record 1st call
			recordKeyUsage("ag-usage", { promptTokens: 10, completionTokens: 25, totalTokens: 35 }, env);
			let found = findApiKey("ag-usage", env);
			assert.equal(found.usage.requests, 1);
			assert.equal(found.usage.promptTokens, 10);
			assert.equal(found.usage.completionTokens, 25);
			assert.equal(found.usage.totalTokens, 35);
			assert.equal(typeof found.lastUsedAt, "number");

			// Record 2nd call
			recordKeyUsage("ag-usage", { promptTokens: 5, completionTokens: 15, totalTokens: 20 }, env);
			found = findApiKey("ag-usage", env);
			assert.equal(found.usage.requests, 2);
			assert.equal(found.usage.promptTokens, 15);
			assert.equal(found.usage.completionTokens, 40);
			assert.equal(found.usage.totalTokens, 55);

			// Reset usage
			resetKeyUsage("ag-usage", env);
			found = findApiKey("ag-usage", env);
			assert.equal(found.usage.requests, 0);
			assert.equal(found.usage.totalTokens, 0);
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});
});

describe("server multi-key usage tracking integration", () => {
	it("tracks requests and token consumption on HTTP server", async () => {
		const env = setupKeyEnv();
		try {
			createApiKey({ name: "Client-A", key: "ag-client-a" }, env);
			createApiKey({ name: "Client-B", key: "ag-client-b", enabled: false }, env);

			const mockGenerate = async () => ({
				text: "Generated response",
				thinking: "",
				toolCalls: [],
				stopReason: "stop",
				usage: { input: 12, output: 8, totalTokens: 20 },
				effort: "medium",
				wireModelId: "gemini-3.8-flash-medium",
			});

			const server = createChatServer({
				apiKey: "fallback-master",
				credentialPath: env.credentialPath,
				apiKeysPath: env.storePath,
				loadCredential: () => ({ access: "tok", refresh: "ref", projectId: "proj" }),
				generate: mockGenerate,
			});

			const address = await listen(server, { host: "127.0.0.1", port: 0 });

			try {
				// 1. Call with disabled key -> 401
				const resDisabled = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer ag-client-b",
					},
					body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
				});
				assert.equal(resDisabled.status, 401);

				// 2. Call with valid Client-A key -> 200
				const resA = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer ag-client-a",
					},
					body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
				});
				assert.equal(resA.status, 200);

				// Verify Client-A usage updated
				const keyA = findApiKey("ag-client-a", env);
				assert.equal(keyA.usage.requests, 1);
				assert.equal(keyA.usage.promptTokens, 12);
				assert.equal(keyA.usage.completionTokens, 8);
				assert.equal(keyA.usage.totalTokens, 20);

				// Client-B usage remains 0
				const keyB = findApiKey("ag-client-b", env);
				assert.equal(keyB.usage.requests, 0);

				// 3. GET /v1/models with Client-A -> 200
				const resModels = await fetch(`http://127.0.0.1:${address.port}/v1/models`, {
					headers: { Authorization: "Bearer ag-client-a" },
				});
				assert.equal(resModels.status, 200);
			} finally {
				await new Promise((resolve) => server.close(resolve));
			}
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});
});
