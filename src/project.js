/**
 * After the Google token exchange, Antigravity still needs a Cloud Code Assist
 * project id. This mirrors the native hub client: loadCodeAssist, onboard the
 * free tier once when the account has no current tier, then load again.
 */
import {
	ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
	CLOUD_CODE_ASSIST_ENDPOINT,
	FREE_TIER_ID,
	ONBOARD_POLL_INTERVAL_MS,
	ONBOARD_TIMEOUT_MS,
	PROVIDER,
} from "./config.js";
import { LoginCancelledError, OAuthError } from "./errors.js";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "./google-validation.js";
import { oauthFetch } from "./oauth.js";
import { getAntigravityUserAgent } from "./user-agent.js";

const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;
const OPERATIONS_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal`;

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
export function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`));
			},
			{ once: true },
		);
	});
}

/** @param {AbortSignal | undefined} signal */
function throwIfLoginCancelled(signal) {
	if (signal?.aborted) {
		throw new LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
	}
}

/** @param {string} label */
function unmarshal(label, detail) {
	return new OAuthError(`failed to unmarshal ${label}${detail ? `: ${detail}` : ""}`, {
		kind: "provisioning",
		provider: PROVIDER,
	});
}

/** @param {unknown} value */
function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{ id?: string } | null | undefined}
 */
function parseTier(value, label) {
	if (value === undefined || value === null) return value;
	if (!isObject(value)) throw unmarshal(label);
	if (value.id !== undefined && typeof value.id !== "string") throw unmarshal(label);
	return { id: typeof value.id === "string" ? value.id : undefined };
}

/** @param {unknown} payload */
function parseLoadCodeAssistResponse(payload) {
	if (!isObject(payload)) throw unmarshal("LoadCodeAssistResponse");
	try {
		const allowed = payload.allowedTiers;
		const ineligible = payload.ineligibleTiers;
		if (allowed !== undefined && !Array.isArray(allowed)) throw unmarshal("LoadCodeAssistResponse");
		if (ineligible !== undefined && !Array.isArray(ineligible)) throw unmarshal("LoadCodeAssistResponse");
		return {
			currentTier: parseTier(payload.currentTier, "LoadCodeAssistResponse"),
			paidTier: parseTier(payload.paidTier, "LoadCodeAssistResponse"),
			allowedTiers: allowed?.map((tier) => {
				const parsed = parseTier(tier, "LoadCodeAssistResponse");
				return parsed ?? {};
			}),
			ineligibleTiers: ineligible?.map((tier) => {
				if (!isObject(tier)) throw unmarshal("LoadCodeAssistResponse");
				for (const key of ["tierId", "reasonMessage", "validationUrl"]) {
					if (tier[key] !== undefined && typeof tier[key] !== "string") throw unmarshal("LoadCodeAssistResponse");
				}
				return {
					tierId: typeof tier.tierId === "string" ? tier.tierId : undefined,
					reasonMessage: typeof tier.reasonMessage === "string" ? tier.reasonMessage : undefined,
					validationUrl: typeof tier.validationUrl === "string" ? tier.validationUrl : undefined,
				};
			}),
			cloudaicompanionProject:
				typeof payload.cloudaicompanionProject === "string" ? payload.cloudaicompanionProject : undefined,
		};
	} catch (error) {
		if (error instanceof OAuthError) throw error;
		throw unmarshal("LoadCodeAssistResponse", error instanceof Error ? error.message : String(error));
	}
}

/** @param {unknown} payload */
function parseOnboardOperation(payload) {
	if (!isObject(payload)) throw unmarshal("OnboardUser operation");
	if (payload.name !== undefined && typeof payload.name !== "string") throw unmarshal("OnboardUser operation");
	if (payload.done !== undefined && typeof payload.done !== "boolean") throw unmarshal("OnboardUser operation");
	if (payload.error !== undefined && payload.error !== null && !isObject(payload.error)) {
		throw unmarshal("OnboardUser operation");
	}
	if (payload.response !== undefined && payload.response !== null) {
		if (!isObject(payload.response) || typeof payload.response["@type"] !== "string") {
			throw unmarshal("OnboardUser operation");
		}
	}
	const error = isObject(payload.error) ? payload.error : payload.error;
	return {
		name: typeof payload.name === "string" ? payload.name : undefined,
		done: typeof payload.done === "boolean" ? payload.done : undefined,
		error:
			error && typeof error === "object"
				? {
						code: typeof error.code === "number" ? error.code : undefined,
						message: typeof error.message === "string" ? error.message : undefined,
					}
				: error,
		response: isObject(payload.response)
			? {
					"@type": payload.response["@type"],
					cloudaicompanionProject:
						typeof payload.response.cloudaicompanionProject === "string"
							? payload.response.cloudaicompanionProject
							: undefined,
				}
			: payload.response,
	};
}

/** @param {{ cloudaicompanionProject?: string }} payload */
function extractProjectId(payload) {
	const projectId = payload.cloudaicompanionProject;
	return projectId && projectId.length > 0 ? projectId : undefined;
}

/** @param {Record<string, unknown>} payload @param {"currentTier" | "paidTier"} field */
function hasMessageField(payload, field) {
	return payload[field] !== undefined && payload[field] !== null;
}

/** @param {{ allowedTiers?: { id?: string }[] }} payload */
function isFreeTierAllowed(payload) {
	return payload.allowedTiers?.some((tier) => tier.id === FREE_TIER_ID) === true;
}

/** @param {{ ineligibleTiers?: { tierId?: string, reasonMessage?: string, validationUrl?: string }[] }} payload */
function getFreeTierIneligibility(payload) {
	const tier = payload.ineligibleTiers?.find((candidate) => candidate.tierId === FREE_TIER_ID);
	if (!tier?.reasonMessage) return undefined;
	return {
		reasonMessage: tier.reasonMessage,
		validationUrl: tier.validationUrl && tier.validationUrl.length > 0 ? tier.validationUrl : undefined,
	};
}

/** @param {ReturnType<typeof parseLoadCodeAssistResponse>} payload */
function assertFreeTierEligible(payload) {
	if (isFreeTierAllowed(payload)) return;
	const ineligibility = getFreeTierIneligibility(payload);
	if (!ineligibility) return;
	const validation = ineligibility.validationUrl ? `\n${ineligibility.validationUrl}` : "";
	throw new OAuthError(`${ineligibility.reasonMessage}${validation}`, {
		kind: "provisioning",
		provider: PROVIDER,
	});
}

/**
 * @param {object} request
 * @param {string} request.label
 * @param {string} request.url
 * @param {"GET" | "POST"} request.method
 * @param {Record<string, string>} request.headers
 * @param {string} [request.body]
 * @param {AbortSignal} [request.signal]
 * @param {number} [request.timeoutMs]
 * @param {typeof fetch} [request.fetch]
 */
async function requestCloudCodeAssist(request) {
	throwIfLoginCancelled(request.signal);
	const init = request.body === undefined ? { method: request.method, headers: request.headers } : { method: request.method, headers: request.headers, body: request.body };
	const response = await oauthFetch(request.url, init, {
		fetch: request.fetch,
		signal: request.signal,
		timeoutMs: request.timeoutMs,
	});
	if (response.status !== 200) {
		const errorText = await response.text();
		throw new OAuthError(`${request.label} failed: ${response.status} ${response.statusText}: ${errorText}`, {
			kind: "provisioning",
			provider: PROVIDER,
			status: response.status,
		});
	}
	return response.json();
}

/** @param {number} deadline */
function remainingOnboardTime(deadline) {
	const remaining = deadline - Date.now();
	if (remaining > 0) return remaining;
	throw new OAuthError(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`, {
		kind: "timeout",
		provider: PROVIDER,
	});
}

/** @param {{ code?: number, message?: string } | null | undefined} error */
function describeOperationError(error) {
	if (error?.message) {
		return typeof error.code === "number" ? `${error.code}: ${error.message}` : error.message;
	}
	return JSON.stringify(error) ?? String(error);
}

/**
 * @param {CloudContext} context
 * @param {Record<string, unknown>} body
 */
async function postLoadCodeAssist(context, body) {
	const payload = await requestCloudCodeAssist({
		...context,
		label: "loadCodeAssist",
		url: LOAD_CODE_ASSIST_URL,
		method: "POST",
		body: JSON.stringify(body),
	});
	return parseLoadCodeAssistResponse(payload);
}

/** @param {CloudContext} context */
async function loadCodeAssist(context) {
	let payload = await postLoadCodeAssist(context, {
		metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
	});
	const projectId = extractProjectId(payload);
	if (!hasMessageField(payload, "paidTier") && projectId) {
		payload = await postLoadCodeAssist(context, {
			cloudaicompanionProject: projectId,
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		});
	}
	return payload;
}

/** @param {CloudContext} context */
async function onboardUser(context) {
	const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
	let operation = parseOnboardOperation(
		await requestCloudCodeAssist({
			...context,
			label: "onboardUser",
			url: ONBOARD_USER_URL,
			method: "POST",
			body: JSON.stringify({
				tierId: FREE_TIER_ID,
				metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
			}),
			timeoutMs: remainingOnboardTime(deadline),
		}),
	);

	while (true) {
		if (operation.done === true) {
			if (operation.error !== undefined && operation.error !== null) {
				throw new OAuthError(`OnboardUser operation failed: ${describeOperationError(operation.error)}`, {
					kind: "provisioning",
					provider: PROVIDER,
				});
			}
			if (operation.response === undefined || operation.response === null) {
				throw new OAuthError("failed to unmarshal OnboardUserResponse", {
					kind: "provisioning",
					provider: PROVIDER,
				});
			}
			return;
		}

		const wait = Math.min(ONBOARD_POLL_INTERVAL_MS, remainingOnboardTime(deadline));
		await (context.sleep ?? sleep)(wait, context.signal);
		throwIfLoginCancelled(context.signal);
		const operationName = operation.name ?? "";
		if (operationName.length === 0) {
			throw new OAuthError("onboardUser returned an operation without a name", {
				kind: "provisioning",
				provider: PROVIDER,
			});
		}
		operation = parseOnboardOperation(
			await requestCloudCodeAssist({
				...context,
				label: "onboardUser operation",
				url: `${OPERATIONS_URL}/${operationName}`,
				method: "GET",
				timeoutMs: remainingOnboardTime(deadline),
			}),
		);
	}
}

/**
 * @typedef {object} CloudContext
 * @property {Record<string, string>} headers
 * @property {AbortSignal} [signal]
 * @property {typeof fetch} [fetch]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 */

/**
 * @param {string} accessToken
 * @param {{
 *   onProgress?: (message: string) => void,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   userAgent?: string,
 * }} [options]
 */
export async function discoverProject(accessToken, options = {}) {
	/** @type {CloudContext} */
	const context = {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": options.userAgent ?? getAntigravityUserAgent(),
		},
		signal: options.signal,
		fetch: options.fetch,
		sleep: options.sleep,
	};

	options.onProgress?.("Checking Cloud Code Assist account status...");
	try {
		const initial = await loadCodeAssist(context);
		assertFreeTierEligible(initial);
		if (!hasMessageField(initial, "currentTier")) {
			options.onProgress?.("Provisioning the Antigravity free tier...");
			await onboardUser(context);
		}

		options.onProgress?.("Refreshing Cloud Code Assist project...");
		const refreshed = await loadCodeAssist(context);
		const projectId = extractProjectId(refreshed);
		if (projectId) return projectId;
		throw new OAuthError("loadCodeAssist did not return a cloudaicompanionProject", {
			kind: "provisioning",
			provider: PROVIDER,
		});
	} catch (error) {
		throwIfLoginCancelled(options.signal);
		if (error instanceof LoginCancelledError || error instanceof OAuthError) throw error;
		throw new OAuthError(
			`Could not discover an Antigravity project. ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "discovery", provider: PROVIDER, cause: error },
		);
	}
}

/**
 * Login discovers the project. Refresh keeps the project id already stored.
 * @param {{ access: string, refresh: string, expires: number, email?: string, projectId?: string }} credentials
 * @param {{
 *   phase?: "login" | "refresh",
 *   raw?: unknown,
 *   stored?: { projectId?: string },
 *   onProgress?: (message: string) => void,
 *   signal?: AbortSignal,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} context
 */
export async function googleAntigravityProjectHook(credentials, context) {
	if (context.phase === "refresh") {
		return context.stored?.projectId ? { ...credentials, projectId: context.stored.projectId } : credentials;
	}
	const raw = context.raw;
	if (
		raw === null ||
		typeof raw !== "object" ||
		typeof /** @type {Record<string, unknown>} */ (raw).refresh_token !== "string" ||
		/** @type {Record<string, unknown>} */ (raw).refresh_token === ""
	) {
		throw new OAuthError("No refresh token received. Please try again.", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	let projectId;
	try {
		projectId = await discoverProject(credentials.access, context);
	} catch (error) {
		const validationUrl = extractGoogleValidationUrl(error instanceof Error ? error.message : String(error));
		if (!validationUrl) throw error;
		throw new OAuthError(formatGoogleValidationRequiredMessage(validationUrl, "sign in again", credentials.email), {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return { ...credentials, projectId };
}
