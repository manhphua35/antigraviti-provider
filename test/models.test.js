import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ANTIGRAVITY_DAILY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
	collapseAntigravityModels,
	fetchAntigravityDiscovery,
	mapEffortToGoogleThinkingLevel,
	modelsFromDiscoveryPayload,
	catalogAntigravityModel,
	GEMINI_4_ARGON_ID,
	resolveThinking,
	resolveWireModelId,
	selectModel,
} from "../src/models.js";

function payload() {
	return {
		models: {
			chat_20706: { displayName: "Hidden", supportsThinking: false },
			"gemini-2.5-pro": { displayName: "Denied", supportsThinking: true },
			"internal-model": { displayName: "Internal", isInternal: true, supportsThinking: true },
			"gemini-3.1-pro-low": {
				displayName: "Gemini 3.1 Pro Low",
				supportsThinking: true,
				supportsImages: true,
				maxTokens: 200000,
				maxOutputTokens: 65535,
			},
			"gemini-pro-agent": {
				displayName: "Gemini Pro Agent",
				supportsThinking: true,
				supportsImages: true,
				maxTokens: 200000,
				maxOutputTokens: 65535,
			},
			"gemini-3.1-pro-high": { displayName: "Retired", supportsThinking: true },
			"gemini-3.7-flash-high": { displayName: "Gemini 3.7 Flash High", supportsThinking: true, maxTokens: 1000 },
			"gemini-3.7-flash-low": { displayName: "Gemini 3.7 Flash Low", supportsThinking: true, supportsImages: true },
			"gemini-3.7-flash-medium": { displayName: "Gemini 3.7 Flash Medium", supportsThinking: true },
			"claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", supportsThinking: true },
			"claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6 Thinking", supportsThinking: true },
			"gemini-3-flash": { displayName: "Alias", supportsThinking: true },
			"gemini-3.5-flash-extra-low": { displayName: "Gemini 3.5 Flash", supportsThinking: true },
			"plain-model": { displayName: "Plain", supportsThinking: false, maxTokens: 10, maxOutputTokens: 20 },
		},
		imageGenerationModelIds: ["gemini-3-pro-image"],
	};
}

describe("Antigravity catalog model", () => {
	it("routes gemini-3.8-flash medium without discovery", () => {
		const model = catalogAntigravityModel("gemini-3.8-flash");
		assert.equal(model.id, "gemini-3.8-flash");
		assert.equal(model.thinking.mode, "google-level");
		assert.equal(resolveWireModelId(model, "medium"), "gemini-3.8-flash-medium");
		assert.equal(model.compat.flashStreamLeakWorkaround, true);
		assert.equal(model.compat.streamFirstEventTimeoutMs, 300_000);
		assert.equal(model.contextWindow, 1_048_576);
		assert.equal(model.maxTokens, 65_536);
	});

	it("routes gemini-4-argon by thinking level without discovery", () => {
		const model = catalogAntigravityModel(GEMINI_4_ARGON_ID);
		assert.equal(model.id, "gemini-4-argon");
		assert.equal(model.name, "Gemini 4 Argon");
		assert.equal(model.thinking.mode, "google-level");
		assert.equal(model.thinking.requiresEffort, true);
		assert.deepEqual(model.thinking.efforts, ["low", "medium", "high"]);
		assert.equal(model.requestModelId, "gemini-4-argon-low");
		assert.equal(model.contextWindow, 1_048_576);
		assert.equal(model.maxTokens, 65_536);

		const off = resolveThinking(model, { effort: "off" });
		assert.equal(off.effort, "low");
		assert.equal(off.wireModelId, "gemini-4-argon-low");
		assert.equal(off.thinking.level, "LOW");

		const medium = resolveThinking(model, { effort: "medium" });
		assert.equal(medium.wireModelId, "gemini-4-argon-medium");
		assert.equal(medium.thinking.level, "MEDIUM");

		const high = resolveThinking(model, { effort: "high" });
		assert.equal(high.wireModelId, "gemini-4-argon-high");
		assert.equal(high.thinking.level, "HIGH");
	});
});

describe("Antigravity model discovery", () => {
	it("drops denied and internal ids, collapses families, and sorts by name", () => {
		const listed = modelsFromDiscoveryPayload(payload(), ANTIGRAVITY_DAILY_ENDPOINT);
		assert.ok(listed);
		assert.equal(listed.imageModel.id, "gemini-3-pro-image");
		const ids = listed.models.map((model) => model.id);
		assert.equal(ids.includes("chat_20706"), false);
		assert.equal(ids.includes("gemini-2.5-pro"), false);
		assert.equal(ids.includes("internal-model"), false);
		assert.equal(ids.includes("gemini-3.1-pro-low"), false);
		assert.equal(ids.includes("gemini-3.7-flash-low"), false);
		assert.deepEqual(ids, [...ids].sort((a, b) => {
			const left = listed.models.find((model) => model.id === a);
			const right = listed.models.find((model) => model.id === b);
			return left.name.localeCompare(right.name, "en") || left.id.localeCompare(right.id, "en");
		}));

		const pro = selectModel(listed.models, "gemini-3.1-pro").model;
		assert.equal(pro.requestModelId, "gemini-3.1-pro-low");
		assert.equal(pro.thinking.mode, "budget");
		assert.equal(pro.thinking.suppressWhenOff, true);
		assert.equal(pro.thinking.effortRouting.off, "gemini-3.1-pro-low");
		assert.equal(pro.thinking.effortRouting.high, "gemini-pro-agent");
		assert.equal(pro.thinking.effortBudgets.high, 10001);
		assert.equal(pro.input.includes("image"), true);
		assert.equal(pro.compat.requiresSkipThoughtSignatureOnFirstFunctionCall, true);

		const flash = selectModel(listed.models, "gemini-3.7-flash").model;
		assert.equal(flash.thinking.requiresEffort, true);
		assert.equal(flash.thinking.mode, "google-level");
		assert.equal(flash.requestModelId, "gemini-3.7-flash-low");
		assert.equal(flash.thinking.effortRouting.minimal, flash.thinking.effortRouting.low);
		assert.equal(mapEffortToGoogleThinkingLevel("minimal", flash), "LOW");
		assert.equal(mapEffortToGoogleThinkingLevel("high", flash), "HIGH");

		const sonnet = selectModel(listed.models, "claude-sonnet-4-6").model;
		assert.equal(sonnet.requestModelId, undefined);
		assert.equal(sonnet.className, "anthropic");
		assert.equal(sonnet.compat.antigravityUsageLabel, "true");
		assert.equal(sonnet.compat.antigravityClaudeToolMode, true);

		const opus = selectModel(listed.models, "claude-opus-4-6").model;
		assert.equal(opus.requestModelId, "claude-opus-4-6-thinking");

		const alias = selectModel(listed.models, "gemini-3-flash");
		assert.equal(alias.model.id, "gemini-3.5-flash");
		const wire = selectModel(listed.models, "gemini-pro-agent");
		assert.equal(wire.model.id, "gemini-3.1-pro");
		assert.equal(wire.effort, "high");
		assert.equal(selectModel(listed.models, "plain-model").model.id, "plain-model");
		assert.throws(() => selectModel(listed.models, "missing"), /Unknown model/);
	});

	it("routes thinking off, budgets, and mandatory flash effort", () => {
		const listed = modelsFromDiscoveryPayload(payload(), ANTIGRAVITY_DAILY_ENDPOINT);
		const pro = selectModel(listed.models, "gemini-3.1-pro").model;
		const off = resolveThinking(pro, {});
		assert.equal(off.effort, undefined);
		assert.equal(off.wireModelId, "gemini-3.1-pro-low");
		assert.equal(off.thinking.suppress.budget, 0);

		const high = resolveThinking(pro, { effort: "high", maxTokens: 2000 });
		assert.equal(high.wireModelId, "gemini-pro-agent");
		assert.equal(high.thinking.budgetTokens, 10001);
		assert.equal(high.maxTokens, 12001);

		const flash = selectModel(listed.models, "gemini-3.7-flash").model;
		const mandatory = resolveThinking(flash, {});
		assert.equal(mandatory.effort, "minimal");
		assert.equal(mandatory.wireModelId, "gemini-3.7-flash-low");
		assert.equal(mandatory.thinking.level, "LOW");
		const medium = resolveThinking(flash, { effort: "medium" });
		assert.equal(medium.wireModelId, "gemini-3.7-flash-medium");
		assert.equal(medium.thinking.level, "MEDIUM");
	});

	it("tries the sandbox host when the daily host fails", async () => {
		const calls = [];
		const fetchImpl = async (url, init) => {
			const href = String(url);
			calls.push(href);
			assert.equal(init.method, "POST");
			assert.equal(init.body, "{}");
			assert.equal(init.headers.Authorization, "Bearer access-token");
			assert.match(init.headers["User-Agent"], /^antigravity\/hub\//);
			if (href.includes("manifest")) return new Response("version: 2.8.0\n");
			if (href.startsWith(ANTIGRAVITY_DAILY_ENDPOINT)) return new Response("nope", { status: 503 });
			if (href.startsWith(ANTIGRAVITY_SANDBOX_ENDPOINT)) {
				return Response.json({ models: { "plain-model": { displayName: "Plain", supportsThinking: false } } });
			}
			throw new Error(href);
		};
		const listed = await fetchAntigravityDiscovery({ token: "access-token", fetch: fetchImpl });
		assert.equal(listed.endpoint, ANTIGRAVITY_SANDBOX_ENDPOINT);
		assert.equal(listed.models[0].id, "plain-model");
		assert.equal(calls.some((href) => href.startsWith(ANTIGRAVITY_DAILY_ENDPOINT)), true);
	});

	it("returns null when every discovery host fails", async () => {
		const fetchImpl = async (url) => {
			if (String(url).includes("manifest")) return new Response("version: 2.8.0\n");
			return new Response("no", { status: 401 });
		};
		assert.equal(await fetchAntigravityDiscovery({ token: "access-token", fetch: fetchImpl }), null);
	});

	it("collapses gemini-4-argon thinking SKUs into one model", () => {
		const listed = modelsFromDiscoveryPayload(
			{
				models: {
					"gemini-4-argon": { displayName: "Gemini 4 Argon", supportsThinking: true, supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536 },
					"gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", supportsThinking: true, supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536 },
					"gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", supportsThinking: true, supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536 },
					"gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", supportsThinking: true, supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536 },
				},
			},
			ANTIGRAVITY_DAILY_ENDPOINT,
		);
		assert.deepEqual(listed.models.map((model) => model.id), ["gemini-4-argon"]);
		const argon = selectModel(listed.models, "gemini-4-argon").model;
		assert.equal(argon.contextWindow, 1048576);
		assert.equal(argon.maxTokens, 65536);
		assert.equal(argon.thinking.effortRouting.low, "gemini-4-argon-low");
		assert.equal(argon.thinking.effortRouting.medium, "gemini-4-argon-medium");
		assert.equal(argon.thinking.effortRouting.high, "gemini-4-argon-high");
		assert.equal(argon.input.includes("image"), true);
		const picked = selectModel(listed.models, "gemini-4-argon-high");
		assert.equal(picked.model.id, "gemini-4-argon");
		assert.equal(picked.effort, "high");
	});

	it("keeps gemini-4-argon when discovery only advertises the medium SKU", () => {
		const listed = modelsFromDiscoveryPayload(
			{
				models: {
					"gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536 },
				},
			},
			ANTIGRAVITY_DAILY_ENDPOINT,
		);
		const argon = selectModel(listed.models, "gemini-4-argon").model;
		assert.equal(argon.requestModelId, "gemini-4-argon-medium");
		assert.equal(argon.thinking.effortRouting.medium, "gemini-4-argon-medium");
		assert.equal(argon.thinking.effortRouting.low, undefined);
		const medium = resolveThinking(argon, {});
		assert.equal(medium.effort, "medium");
		assert.equal(medium.wireModelId, "gemini-4-argon-medium");
		assert.equal(medium.thinking.level, "MEDIUM");
	});

	it("leaves an already-logical id untouched when no sibling wire ids are present", () => {
		const models = collapseAntigravityModels([
			{
				id: "custom-model",
				name: "Custom",
				provider: "google-antigravity",
				input: ["text"],
				reasoning: false,
				contextWindow: 10,
				maxTokens: 20,
			},
		]);
		assert.equal(models[0].id, "custom-model");
		assert.equal(models[0].compat.supportsFunctionPartId, true);
	});
});
