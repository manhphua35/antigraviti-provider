import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import { modelsFromDiscoveryPayload, ANTIGRAVITY_DAILY_ENDPOINT } from "../src/models.js";
import {
	buildAntigravityRequest,
	consumePlanningBuffer,
	convertMessages,
	deriveSignedDecimalFromHash,
	FORCED_TOOL_DIRECTIVE,
} from "../src/request.js";

function model(id) {
	const listed = modelsFromDiscoveryPayload(
		{
			models: {
				"gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro", supportsThinking: true, supportsImages: true },
				"gemini-pro-agent": { displayName: "Gemini Pro Agent", supportsThinking: true, supportsImages: true },
				"gemini-3.7-flash-low": { displayName: "Gemini 3.7 Flash", supportsThinking: true },
				"gemini-3.7-flash-medium": { displayName: "Gemini 3.7 Flash Medium", supportsThinking: true },
				"gemini-3.7-flash-high": { displayName: "Gemini 3.7 Flash High", supportsThinking: true },
				"claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", supportsThinking: true },
				"gemini-2.5-flash": { displayName: "Gemini 2.5 Flash", supportsThinking: true },
			},
		},
		ANTIGRAVITY_DAILY_ENDPOINT,
	);
	return listed.models.find((entry) => entry.id === id);
}

const ids = {
	now: () => 1_700_000_000_000,
	randomUUID: () => "uuid",
	randomSessionId: () => "-99",
};

describe("Antigravity request envelope", () => {
	it("derives the signed session id from the first eight SHA-256 bytes", () => {
		const digest = crypto.createHash("sha256").update("hello").digest();
		let value = 0n;
		for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(digest[index]);
		const mask = (1n << 63n) - 1n;
		assert.equal(deriveSignedDecimalFromHash("hello"), `-${(value & mask).toString()}`);
	});

	it("builds the hub envelope, suppresses thinking when off, and overwrites the output cap", () => {
		const state = {};
		const { body, resolved } = buildAntigravityRequest(
			model("gemini-3.1-pro"),
			{ systemPrompt: "Be brief", messages: [{ role: "user", content: "hello" }], temperature: 0.2 },
			"project-123",
			state,
			ids,
		);
		assert.equal(resolved.wireModelId, "gemini-3.1-pro-low");
		assert.deepEqual(Object.keys(body), ["project", "requestId", "request", "model", "userAgent", "requestType"]);
		assert.equal(body.project, "project-123");
		assert.equal(body.userAgent, "antigravity");
		assert.equal(body.requestType, "agent");
		assert.equal(body.model, "gemini-3.1-pro-low");
		assert.equal(body.requestId, "agent/uuid/1700000000000/uuid/2");
		assert.equal(body.request.sessionId, "-99");
		assert.equal(state.stepIndex, 2);
		assert.deepEqual(body.request.systemInstruction, { role: "user", parts: [{ text: "Be brief" }] });
		assert.equal(body.request.labels.last_step_index, "1");
		assert.equal(body.request.labels.model_enum, "MODEL_PLACEHOLDER_M36");
		assert.equal(body.request.labels.trajectory_id, "uuid");
		assert.equal(body.request.labels.used_claude, "false");
		assert.equal(body.request.labels.used_claude_conservative, "false");
		assert.equal(body.request.generationConfig.maxOutputTokens, 65535);
		assert.equal(body.request.generationConfig.temperature, 0.2);
		assert.deepEqual(body.request.generationConfig.thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
		assert.deepEqual(Object.keys(body.request), ["contents", "systemInstruction", "labels", "generationConfig", "sessionId"]);
		assert.deepEqual(body.request.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
	});

	it("routes high effort to the pro agent profile and advances the step", () => {
		const state = { agentId: "agent", trajectoryId: "traj", sessionId: "-5", stepIndex: 2, lastExecutionId: "prev" };
		const { body } = buildAntigravityRequest(
			model("gemini-3.1-pro"),
			{ messages: [{ role: "user", content: "again" }], effort: "high" },
			"project-123",
			state,
			ids,
		);
		assert.equal(body.model, "gemini-pro-agent");
		assert.equal(body.request.labels.model_enum, "MODEL_PLACEHOLDER_M16");
		assert.equal(body.request.labels.last_execution_id, "prev");
		assert.equal(body.request.labels.last_step_index, "2");
		assert.equal(body.requestId.endsWith("/3"), true);
		assert.equal(body.request.generationConfig.maxOutputTokens, 65535);
		assert.equal(body.request.generationConfig.thinkingConfig.thinkingBudget, 10001);
		assert.equal(body.request.generationConfig.thinkingConfig.includeThoughts, true);
		assert.equal(state.stepIndex, 3);
	});

	it("sends LOW for Flash minimal and VALIDATED tools, with ANY copied into the transcript", () => {
		const flash = buildAntigravityRequest(
			model("gemini-3.7-flash"),
			{
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						name: "lookup",
						description: "Find",
						parameters: {
							type: "object",
							properties: { q: { type: "string", format: "email" } },
							required: ["q"],
						},
					},
				],
			},
			"project-123",
			{ agentId: "a", trajectoryId: "t", sessionId: "-1", stepIndex: 1 },
			ids,
		);
		assert.equal(flash.body.model, "gemini-3.7-flash-low");
		assert.equal(flash.body.request.generationConfig.thinkingConfig.thinkingLevel, "LOW");
		assert.equal(flash.body.request.toolConfig.functionCallingConfig.mode, "VALIDATED");
		assert.equal(flash.body.request.tools[0].functionDeclarations[0].parameters.properties.q.format, undefined);
		assert.match(flash.body.request.tools[0].functionDeclarations[0].parameters.properties.q.description, /format/);

		const forced = buildAntigravityRequest(
			model("gemini-3.1-pro"),
			{
				messages: [{ role: "user", content: "hi" }],
				effort: "low",
				toolChoice: "any",
				tools: [{ name: "lookup", parameters: { anyOf: [{ type: "object" }] } }],
			},
			"project-123",
			undefined,
			ids,
		);
		assert.equal(forced.body.request.toolConfig.functionCallingConfig.mode, "ANY");
		assert.equal(forced.body.request.contents.at(-1).parts[0].text, FORCED_TOOL_DIRECTIVE);
		assert.deepEqual(forced.body.request.tools[0].functionDeclarations[0].parameters, { type: "object", properties: {} });
		assert.equal(forced.body.request.sessionId, deriveSignedDecimalFromHash("hi"));
	});

	it("forces VALIDATED for Claude even when no tools are declared", () => {
		const { body } = buildAntigravityRequest(
			model("claude-sonnet-4-6"),
			{ messages: [{ role: "user", content: "hi" }], effort: "high" },
			"project-123",
			{ agentId: "a", trajectoryId: "t", sessionId: "-1", stepIndex: 1 },
			ids,
		);
		assert.equal(body.model, "claude-sonnet-4-6");
		assert.equal(body.request.labels.used_claude, "true");
		assert.equal(body.request.labels.model_enum, undefined);
		assert.equal(body.request.generationConfig.maxOutputTokens, 64000);
		assert.equal(body.request.toolConfig.functionCallingConfig.mode, "VALIDATED");
		assert.equal(body.request.tools, undefined);
		assert.equal(body.request.generationConfig.thinkingConfig.thinkingBudget > 0, true);
	});

	it("replays a valid signature and puts the skip sentinel only on the first unsigned Gemini 3 call", () => {
		const pro = model("gemini-3.1-pro");
		const signed = convertMessages(pro, [
			{
				role: "assistant",
				provider: "google-antigravity",
				model: "gemini-3.1-pro",
				content: [
					{ type: "toolCall", id: "call_1", name: "one", arguments: { a: 1 }, thoughtSignature: "AQIDBA==" },
					{ type: "toolCall", id: "call_2", name: "two", arguments: {} },
				],
			},
		]);
		assert.equal(signed[0].parts[0].thoughtSignature, "AQIDBA==");
		assert.equal(signed[0].parts[0].functionCall.id, "call_1");
		assert.equal(signed[0].parts[1].thoughtSignature, undefined);

		const unsigned = convertMessages(pro, [
			{
				role: "assistant",
				provider: "google-antigravity",
				model: "gemini-3.1-pro",
				content: [
					{ type: "toolCall", id: "call_1", name: "one", arguments: {} },
					{ type: "toolCall", id: "call_2", name: "two", arguments: {} },
				],
			},
		]);
		assert.equal(unsigned[0].parts[0].thoughtSignature, "skip_thought_signature_validator");
		assert.equal(unsigned[0].parts[1].thoughtSignature, undefined);

		const older = convertMessages(model("gemini-2.5-flash"), [
			{
				role: "assistant",
				provider: "google-antigravity",
				model: "gemini-2.5-flash",
				content: [{ type: "toolCall", id: "call_1", name: "one", arguments: {} }],
			},
		]);
		assert.equal(older[0].parts[0].thoughtSignature, undefined);
	});

	it("strips a leading planning-leak object from Flash text", () => {
		const buffered = consumePlanningBuffer('{"thought":"secret"} visible', new Set());
		assert.equal(buffered.kind, "leak");
		assert.equal(buffered.visibleText, " visible");
		assert.equal(consumePlanningBuffer("hello", new Set()).kind, "plain");
	});
});
