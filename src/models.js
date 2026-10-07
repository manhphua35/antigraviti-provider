/**
 * Antigravity model list and thinking routing.
 *
 * Discovery is `POST /v1internal:fetchAvailableModels` with an empty body.
 * Wire ids such as `gemini-3.1-pro-low` collapse into the logical models from
 * oh-my-pi's reviewed Antigravity families. A generate call then picks the
 * upstream id with `thinking.effortRouting`.
 */
import { CLOUD_CODE_ASSIST_ENDPOINT, CLOUD_CODE_ASSIST_SANDBOX_ENDPOINT } from "./config.js";
import { AntigravityApiError } from "./errors.js";
import { ensureAntigravityVersion, getAntigravityUserAgent } from "./user-agent.js";

export const ANTIGRAVITY_DAILY_ENDPOINT = CLOUD_CODE_ASSIST_ENDPOINT;
export const ANTIGRAVITY_SANDBOX_ENDPOINT = CLOUD_CODE_ASSIST_SANDBOX_ENDPOINT;
export const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
export const DEFAULT_MODEL_ID = "gemini-3.1-pro";
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 64_000;

const DISCOVERY_DENYLIST = new Set(["chat_20706", "chat_23310", "gemini-2.5-pro"]);

export const THINKING_EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);

export const GOOGLE_THINKING_BUDGETS = Object.freeze({
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 24575,
	max: 32768,
});

export const MIN_OUTPUT_TOKENS = 1024;
const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;

/**
 * Per routed wire id. `maxOutputTokens` replaces the caller cap.
 * @type {Readonly<Record<string, { modelEnum?: string, maxOutputTokens: number }>>}
 */
export const ANTIGRAVITY_MODEL_WIRE_PROFILES = Object.freeze({
	"gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
	"gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
	"gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
	"gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
	"gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
	"claude-sonnet-4-6": { maxOutputTokens: 64000 },
	"claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
});

/**
 * @param {string} wireModelId
 */
export function getAntigravityModelWireProfile(wireModelId) {
	return ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
}

const FLASH_TEMPLATE = /^gemini-(\d+(?:\.\d+){0,2})-flash-(low|medium|high|tiered)$/i;

/**
 * Reviewed families. Member order is the default-wire priority.
 * @type {Array<{
 *   id: string,
 *   name: string,
 *   members: string[],
 *   routing?: Record<string, string>,
 *   retired?: string[],
 *   mode?: string,
 *   efforts?: string[],
 *   budgets?: Record<string, number>,
 *   requiresEffort?: boolean,
 *   suppressWhenOff?: boolean,
 *   preserveAbsentEffortRoutes?: boolean,
 *   aliases?: string[],
 * }>}
 */
const STATIC_FAMILIES = [
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		members: ["gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3-flash-agent"],
		routing: {
			off: "gemini-3.5-flash-extra-low",
			minimal: "gemini-3.5-flash-extra-low",
			low: "gemini-3.5-flash-extra-low",
			medium: "gemini-3.5-flash-low",
			high: "gemini-3-flash-agent",
		},
		mode: "budget",
		efforts: ["minimal", "low", "medium", "high"],
		budgets: { minimal: 1000, low: 1000, medium: 4000, high: 10000 },
		suppressWhenOff: true,
		aliases: ["gemini-3-flash"],
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		members: ["gemini-3.1-pro-low", "gemini-pro-agent", "gemini-3.1-pro-high"],
		routing: {
			off: "gemini-3.1-pro-low",
			low: "gemini-3.1-pro-low",
			high: "gemini-pro-agent",
		},
		retired: ["gemini-3.1-pro-high"],
		mode: "budget",
		efforts: ["low", "high"],
		budgets: { low: 1001, high: 10001 },
		suppressWhenOff: true,
	},
	{
		id: "gemini-3-pro",
		name: "Gemini 3 Pro",
		members: ["gemini-3-pro-low", "gemini-3-pro-high"],
		routing: {
			off: "gemini-3-pro-low",
			low: "gemini-3-pro-low",
			high: "gemini-3-pro-high",
		},
		mode: "google-level",
		efforts: ["low", "high"],
		suppressWhenOff: true,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		members: ["gpt-oss-120b-medium"],
		mode: "budget",
		efforts: ["minimal", "low", "medium", "high"],
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		members: ["claude-sonnet-4-6", "claude-sonnet-4-6-thinking"],
		retired: ["claude-sonnet-4-6-thinking"],
		mode: "budget",
		efforts: ["minimal", "low", "medium", "high"],
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		members: ["claude-opus-4-6-thinking", "claude-opus-4-6"],
		retired: ["claude-opus-4-6"],
		mode: "budget",
		efforts: ["minimal", "low", "medium", "high"],
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		members: ["claude-sonnet-4-5", "claude-sonnet-4-5-thinking"],
		routing: {
			off: "claude-sonnet-4-5",
			minimal: "claude-sonnet-4-5-thinking",
			low: "claude-sonnet-4-5-thinking",
			medium: "claude-sonnet-4-5-thinking",
			high: "claude-sonnet-4-5-thinking",
		},
		mode: "budget",
		efforts: ["minimal", "low", "medium", "high"],
		preserveAbsentEffortRoutes: true,
	},
	{
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5",
		members: ["claude-opus-4-5", "claude-opus-4-5-thinking"],
		routing: {
			off: "claude-opus-4-5",
			minimal: "claude-opus-4-5-thinking",
			low: "claude-opus-4-5-thinking",
			medium: "claude-opus-4-5-thinking",
			high: "claude-opus-4-5-thinking",
		},
		mode: "budget",
		efforts: ["minimal", "low", "medium", "high"],
		preserveAbsentEffortRoutes: true,
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		members: ["gemini-2.5-flash", "gemini-2.5-flash-thinking"],
		routing: {
			off: "gemini-2.5-flash",
			minimal: "gemini-2.5-flash-thinking",
			low: "gemini-2.5-flash-thinking",
			medium: "gemini-2.5-flash-thinking",
			high: "gemini-2.5-flash-thinking",
		},
		mode: "budget",
		efforts: ["minimal", "low", "medium", "high"],
		preserveAbsentEffortRoutes: true,
	},
];

/**
 * @param {string} rev
 * @returns {number[]}
 */
function revisionParts(rev) {
	const parts = String(rev)
		.split(".")
		.map((part) => Number(part));
	while (parts.length < 3) parts.push(0);
	return parts;
}

/**
 * @param {string} left
 * @param {string} right
 */
function compareRevision(left, right) {
	const a = revisionParts(left);
	const b = revisionParts(right);
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
	}
	return 0;
}

/**
 * @param {string} id
 * @returns {string | undefined}
 */
export function geminiRevision(id) {
	const match = /^gemini-(\d+(?:\.\d+){0,2})(?:-|$)/i.exec(id);
	return match?.[1];
}

/**
 * @param {string} rev
 */
function flashTemplateFamily(rev) {
	const low = `gemini-${rev}-flash-low`;
	const medium = `gemini-${rev}-flash-medium`;
	const high = `gemini-${rev}-flash-high`;
	const tiered = `gemini-${rev}-flash-tiered`;
	return {
		id: `gemini-${rev}-flash`,
		name: `Gemini ${rev} Flash`,
		members: [low, medium, high, tiered],
		routing: { minimal: low, low, medium, high },
		mode: "google-level",
		efforts: ["minimal", "low", "medium", "high"],
		requiresEffort: true,
	};
}

/**
 * @param {Iterable<string>} ids
 */
function familiesFor(ids) {
	/** @type {Set<string>} */
	const revisions = new Set();
	for (const id of ids) {
		const match = FLASH_TEMPLATE.exec(id);
		if (!match?.[1]) continue;
		if (compareRevision(match[1], "3.6") >= 0) revisions.add(match[1]);
	}
	return [...STATIC_FAMILIES, ...[...revisions].map((rev) => flashTemplateFamily(rev))];
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 */
function positive(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * @param {unknown} value
 */
function optionalString(value) {
	return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} value
 */
function optionalBoolean(value) {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * @param {unknown} value
 */
function optionalNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {string} endpoint
 * @param {string} modelId
 * @param {Record<string, unknown>} model
 */
function specFromDiscovery(endpoint, modelId, model) {
	const supportsImages = model.supportsImages === true;
	return {
		id: modelId,
		name: optionalString(model.displayName) || modelId,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: endpoint,
		reasoning: model.supportsThinking === true,
		input: supportsImages ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positive(optionalNumber(model.maxTokens), DEFAULT_CONTEXT_WINDOW),
		maxTokens: positive(optionalNumber(model.maxOutputTokens), DEFAULT_MAX_TOKENS),
		recommended: optionalBoolean(model.recommended) === true,
		kind: "chat",
		supportsTools: true,
	};
}

/**
 * @param {object} model
 */
function decorateModel(model) {
	const id = model.id;
	const anthropic = id.startsWith("claude-");
	const gemini = id.startsWith("gemini-") || id.startsWith("gemma-");
	const revision = geminiRevision(id);
	const gemini3 = Boolean(revision && compareRevision(revision, "3") >= 0);
	const flash = id.includes("flash");
	const compat = {
		supportsFunctionPartId: true,
		ccaLegacyParametersSchema: true,
		dropUnsignedThinking: anthropic,
		antigravityClaudeToolMode: anthropic,
		claudeThinkingBetaHeader: anthropic,
		requiresSkipThoughtSignatureOnFirstFunctionCall: gemini && gemini3,
		multimodalFunctionResponse: anthropic || (gemini && gemini3),
		flashStreamLeakWorkaround: flash,
		streamFirstEventTimeoutMs: flash ? 60_000 : undefined,
	};
	if (anthropic) compat.antigravityUsageLabel = "true";
	const next = {
		...model,
		className: anthropic ? "anthropic" : gemini ? "gemini" : "other",
		compat,
	};
	if (id === "gemini-3-pro-image") {
		next.reasoning = false;
		next.supportsTools = false;
		next.kind = "image";
		next.thinking = undefined;
	} else if (id === "gemini-3.1-flash-lite") {
		next.thinking = {
			...(next.thinking ?? {}),
			mode: "google-level",
			efforts: next.thinking?.efforts ?? ["minimal", "low", "medium", "high"],
			requiresEffort: true,
		};
		next.reasoning = true;
	}
	return next;
}

/**
 * @param {Array<object>} specs
 */
export function collapseAntigravityModels(specs) {
	const byId = new Map();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}
	const families = familiesFor(byId.keys());
	/** @type {Map<string, object>} */
	const replacement = new Map();
	/** @type {Map<string, string>} */
	const familyIdBySpecId = new Map();
	/** @type {Set<string>} */
	const claimed = new Set();

	for (const family of families) {
		const retired = new Set(family.retired ?? []);
		const rawPresent = family.members.filter((id) => byId.has(id) && !claimed.has(id));
		if (rawPresent.length === 0) continue;
		for (const id of rawPresent) {
			claimed.add(id);
			familyIdBySpecId.set(id, family.id);
		}
		for (const alias of family.aliases ?? []) {
			if (byId.has(alias)) familyIdBySpecId.set(alias, family.id);
		}

		const presentSet = new Set(rawPresent);
		/** @type {Record<string, string>} */
		const routing = {};
		let hasRouting = false;
		let hasEffortRoute = false;
		for (const effort of ["off", ...THINKING_EFFORTS]) {
			const target = family.routing?.[effort];
			if (!target || retired.has(target)) continue;
			const present = presentSet.has(target);
			const preserve = effort !== "off" && family.preserveAbsentEffortRoutes === true;
			if (!present && !preserve) continue;
			routing[effort] = target;
			hasRouting = true;
			if (effort !== "off") hasEffortRoute = true;
		}

		const memberSpecs = rawPresent.map((id) => byId.get(id)).filter(Boolean);
		const first = memberSpecs[0];
		const reasoning = memberSpecs.some((spec) => spec.reasoning) || hasEffortRoute;
		/** @type {Record<string, unknown> | undefined} */
		let thinking;
		if (family.mode) {
			thinking = {
				mode: family.mode,
				efforts: [...(family.efforts ?? [])],
			};
			if (family.budgets) thinking.effortBudgets = { ...family.budgets };
			if (family.requiresEffort) thinking.requiresEffort = true;
			if (hasRouting) thinking.effortRouting = routing;
			if (family.suppressWhenOff) thinking.suppressWhenOff = true;
		}
		const input = [];
		if (memberSpecs.some((spec) => spec.input?.includes("text"))) input.push("text");
		if (memberSpecs.some((spec) => spec.input?.includes("image"))) input.push("image");
		const contextValues = memberSpecs.map((spec) => spec.contextWindow).filter((value) => typeof value === "number");
		const outputValues = memberSpecs.map((spec) => spec.maxTokens).filter((value) => typeof value === "number");
		const defaultWireId = rawPresent.find((id) => !retired.has(id)) ?? rawPresent[0];
		/** @type {Record<string, unknown>} */
		const collapsed = {
			...first,
			id: family.id,
			name: family.name,
			reasoning,
			input: input.length > 0 ? input : ["text"],
			contextWindow: contextValues.length > 0 ? Math.max(...contextValues) : first.contextWindow,
			maxTokens: outputValues.length > 0 ? Math.max(...outputValues) : first.maxTokens,
			recommended: memberSpecs.some((spec) => spec.recommended),
			aliases: family.aliases ? [...family.aliases] : undefined,
		};
		if (defaultWireId && defaultWireId !== family.id) collapsed.requestModelId = defaultWireId;
		if (reasoning && thinking) collapsed.thinking = thinking;
		replacement.set(family.id, collapsed);
	}

	/** @type {object[]} */
	const collapsed = [];
	/** @type {Set<string>} */
	const emitted = new Set();
	for (const spec of specs) {
		const familyId = familyIdBySpecId.get(spec.id);
		if (!familyId) {
			collapsed.push(spec);
			continue;
		}
		if (emitted.has(familyId)) continue;
		emitted.add(familyId);
		const familySpec = replacement.get(familyId);
		if (familySpec) collapsed.push(familySpec);
	}
	const decorated = collapsed.map((spec) => decorateModel(spec));
	decorated.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
	return decorated;
}

/**
 * @param {unknown} payload
 * @param {string} endpoint
 */
export function modelsFromDiscoveryPayload(payload, endpoint) {
	if (!payload || typeof payload !== "object") return null;
	const record = /** @type {Record<string, unknown>} */ (payload);
	const rawModels = record.models;
	/** @type {object[]} */
	const specs = [];
	if (rawModels && typeof rawModels === "object") {
		for (const [modelId, modelValue] of Object.entries(rawModels)) {
			if (DISCOVERY_DENYLIST.has(modelId)) continue;
			if (!modelValue || typeof modelValue !== "object") continue;
			const model = /** @type {Record<string, unknown>} */ (modelValue);
			if (model.isInternal === true) continue;
			specs.push(specFromDiscovery(endpoint, modelId, model));
		}
	}
	const imageIds = Array.isArray(record.imageGenerationModelIds)
		? record.imageGenerationModelIds.filter((id) => typeof id === "string" && id.length > 0)
		: [];
	return {
		models: collapseAntigravityModels(specs),
		imageModel: imageIds[0] ? { id: imageIds[0], endpoint } : null,
		endpoint,
	};
}

/**
 * @param {string} value
 */
function trimSlashes(value) {
	return value.replace(/\/+$/, "");
}

/**
 * @param {{
 *   token: string,
 *   endpoint?: string,
 *   userAgent?: string,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 * }} options
 */
export async function fetchAntigravityDiscovery(options) {
	if (!options.userAgent) await ensureAntigravityVersion(options.fetch ?? fetch, options.signal);
	const fetcher = options.fetch ?? fetch;
	const endpoints = options.endpoint
		? [trimSlashes(options.endpoint)]
		: [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT];
	for (const endpoint of endpoints) {
		let response;
		try {
			response = await fetcher(`${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.token}`,
					"Content-Type": "application/json",
					"User-Agent": options.userAgent ?? getAntigravityUserAgent(),
				},
				body: "{}",
				signal: options.signal,
			});
		} catch {
			continue;
		}
		if (!response.ok) continue;
		let payload;
		try {
			payload = await response.json();
		} catch {
			continue;
		}
		const parsed = modelsFromDiscoveryPayload(payload, endpoint);
		if (parsed) return parsed;
	}
	return null;
}

/**
 * Logical model from the reviewed families, with no discovery round-trip.
 * omp resolves the wire id from the catalog before `streamGenerateContent`.
 * @param {string} id
 * @param {string} [endpoint]
 */
export function catalogAntigravityModel(id, endpoint = ANTIGRAVITY_DAILY_ENDPOINT) {
	const wanted = id.trim();
	const revision = geminiRevision(wanted);
	/** @type {string[]} */
	let memberIds = [];
	/** @type {string} */
	let name = wanted;
	if (revision && wanted === `gemini-${revision}-flash` && compareRevision(revision, "3.6") >= 0) {
		memberIds = ["low", "medium", "high", "tiered"].map((level) => `gemini-${revision}-flash-${level}`);
		name = `Gemini ${revision} Flash`;
	} else {
		const family = STATIC_FAMILIES.find((item) => item.id === wanted || item.aliases?.includes(wanted));
		if (!family) return undefined;
		memberIds = family.members;
		name = family.name;
	}
	const specs = memberIds.map((memberId) =>
		specFromDiscovery(endpoint, memberId, {
			displayName: name,
			supportsThinking: true,
			supportsImages: memberId.startsWith("gemini-") || memberId.startsWith("gemma-"),
		}),
	);
	return collapseAntigravityModels(specs).find((model) => model.id === wanted || model.aliases?.includes(wanted));
}

/**
 * @param {object} model
 * @param {string | undefined} effort
 */
export function resolveWireModelId(model, effort) {
	return model.thinking?.effortRouting?.[effort ?? "off"] ?? model.requestModelId ?? model.id;
}

/**
 * @param {object} model
 */
export function defaultSupportedEffort(model) {
	const efforts = model.thinking?.efforts ?? [];
	const routing = model.thinking?.effortRouting;
	const defaultWireId = model.requestModelId;
	if (routing && defaultWireId) {
		for (const effort of THINKING_EFFORTS) {
			if (efforts.includes(effort) && routing[effort] === defaultWireId) return effort;
		}
	}
	for (const effort of THINKING_EFFORTS) {
		if (efforts.includes(effort)) return effort;
	}
	return efforts[0];
}

/**
 * @param {object | undefined} model
 * @param {string | undefined} requested
 */
export function clampThinkingLevel(model, requested) {
	if (!model?.reasoning || requested === undefined) return undefined;
	const levels = model.thinking?.efforts ?? [];
	if (levels.includes(requested)) return requested;
	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) return undefined;
	let clamped;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) break;
		clamped = effort;
	}
	return clamped ?? levels[0];
}

/**
 * Cloud Code Assist rejects MINIMAL on the Flash `-low` SKU that also serves minimal.
 * @param {string} effort
 * @param {object} [model]
 * @returns {"MINIMAL" | "LOW" | "MEDIUM" | "HIGH"}
 */
export function mapEffortToGoogleThinkingLevel(effort, model) {
	if (effort === "minimal") {
		const routing = model?.thinking?.effortRouting;
		if (routing?.minimal && routing.minimal === routing.low) return "LOW";
		return "MINIMAL";
	}
	if (effort === "low") return "LOW";
	if (effort === "medium") return "MEDIUM";
	return "HIGH";
}

/**
 * @param {number | undefined} baseMaxTokens
 * @param {number | null | undefined} modelMaxTokens
 * @param {number} thinkingBudget
 */
export function maxTokensWithThinkingBudget(baseMaxTokens, modelMaxTokens, thinkingBudget) {
	const uncapped = baseMaxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : baseMaxTokens + thinkingBudget;
	const cap = modelMaxTokens ?? Number.POSITIVE_INFINITY;
	return Math.min(uncapped, cap);
}

/**
 * Resolve effort, wire id, and the thinkingConfig inputs for one call.
 * @param {object} model
 * @param {{
 *   effort?: string,
 *   disableReasoning?: boolean,
 *   maxTokens?: number,
 *   thinkingBudgets?: Record<string, number>,
 * }} [options]
 */
export function resolveThinking(model, options = {}) {
	let effort = options.effort;
	const requestedOff = options.disableReasoning === true || effort === "off";
	if (effort === "off") effort = undefined;
	const mustReason = Boolean(model.reasoning && model.thinking?.requiresEffort && !model.thinking?.suppressWhenOff);
	if (mustReason && (effort === undefined || requestedOff)) {
		effort = defaultSupportedEffort(model);
	} else if (requestedOff || !model.reasoning) {
		effort = undefined;
	} else if (effort !== undefined) {
		effort = clampThinkingLevel(model, effort);
	}

	let wireModelId = resolveWireModelId(model, effort);
	/** @type {{ enabled: boolean, budgetTokens?: number, level?: string, suppress?: { level: string } | { budget: number } }} */
	let thinking = { enabled: false };
	let maxTokens = options.maxTokens;

	if (effort && model.thinking?.mode === "google-level") {
		thinking = { enabled: true, level: mapEffortToGoogleThinkingLevel(effort, model) };
	} else if (effort && model.reasoning) {
		let budget =
			options.thinkingBudgets?.[effort] ?? model.thinking?.effortBudgets?.[effort] ?? GOOGLE_THINKING_BUDGETS[effort];
		const total = maxTokensWithThinkingBudget(options.maxTokens, model.maxTokens, budget);
		if (total <= budget) budget = Math.max(0, total - MIN_OUTPUT_TOKENS);
		if (budget > 0) {
			thinking = { enabled: true, budgetTokens: budget };
			maxTokens = total;
		} else {
			effort = undefined;
			wireModelId = resolveWireModelId(model, undefined);
		}
	}

	if (!thinking.enabled && model.reasoning && model.thinking?.suppressWhenOff) {
		thinking = {
			enabled: false,
			suppress: model.thinking.mode === "google-level" ? { level: "MINIMAL" } : { budget: 0 },
		};
	}

	return { effort, wireModelId, thinking, maxTokens };
}

/**
 * @param {object[]} models
 * @param {string} id
 */
export function selectModel(models, id) {
	const wanted = id.trim();
	const direct = models.find((model) => model.id === wanted || model.aliases?.includes(wanted));
	if (direct) return { model: direct, effort: undefined };
	for (const model of models) {
		const routes = model.thinking?.effortRouting ?? {};
		const matched = Object.entries(routes).filter(([, wire]) => wire === wanted);
		if (model.requestModelId === wanted || matched.length > 0) {
			const effort = matched.find(([key]) => key !== "off")?.[0];
			return { model, effort };
		}
	}
	const available = models.map((model) => model.id).join(", ");
	throw new AntigravityApiError(
		available ? `Unknown model "${wanted}". Available models: ${available}` : `Unknown model "${wanted}".`,
		{ kind: "validation" },
	);
}

/**
 * @param {object[]} models
 * @param {string} [requested]
 */
export function chooseModel(models, requested) {
	if (requested) return selectModel(models, requested);
	const preferred = models.find((model) => model.id === DEFAULT_MODEL_ID) ?? models[0];
	if (!preferred) throw new AntigravityApiError("Antigravity returned no models.", { kind: "discovery" });
	return { model: preferred, effort: undefined };
}
