/**
 * Authorization-code grant for Antigravity.
 * PKCE is not used. `access_type=offline` and `prompt=consent` are what make
 * Google return a refresh token.
 */
import crypto from "node:crypto";
import { AUTHORIZE_URL, EXPIRY_SKEW_MS, OAUTH_REQUEST_TIMEOUT_MS, PROVIDER, SCOPES, TOKEN_URL, USERINFO_URL, clientCredentials } from "./config.js";
import { LoginCancelledError, OAuthError } from "./errors.js";

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfCancelled(signal) {
	if (signal?.aborted) {
		throw new LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
	}
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function oauthFetch(url, init, options = {}) {
	const fetchImpl = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	try {
		return await fetchImpl(url, { ...init, signal });
	} catch (error) {
		if (options.signal?.aborted) {
			throw new LoginCancelledError(`OAuth login cancelled: ${String(options.signal.reason)}`);
		}
		if (timeoutSignal.aborted) {
			throw new OAuthError(`Timed out after ${timeoutMs}ms waiting for ${url}`, { kind: "timeout", cause: error });
		}
		throw error;
	}
}

/** 16-byte hex CSRF state. */
export function generateState() {
	return crypto.randomBytes(16).toString("hex");
}

/**
 * @param {{ redirectUri: string, state: string, clientId?: string }} input
 */
export function buildAuthorizeUrl(input) {
	const clientId = input.clientId ?? clientCredentials().clientId;
	const params = new URLSearchParams();
	params.set("client_id", clientId);
	params.set("response_type", "code");
	params.set("redirect_uri", input.redirectUri);
	params.set("scope", SCOPES.join(" "));
	if (input.state) params.set("state", input.state);
	params.set("access_type", "offline");
	params.set("prompt", "consent");
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * @param {Record<string, string | undefined>} fields
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 * @param {"token-exchange" | "token-refresh"} [errorKind]
 */
async function postToken(fields, options = {}, errorKind = "token-exchange") {
	throwIfCancelled(options.signal);
	const { clientId, clientSecret } = clientCredentials();
	const params = new URLSearchParams();
	const payload = {
		client_id: clientId,
		client_secret: clientSecret,
		...fields,
	};
	for (const [key, value] of Object.entries(payload)) {
		if (value !== undefined) params.set(key, value);
	}
	const response = await oauthFetch(
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		},
		options,
	);
	const text = await response.text();
	if (!response.ok) {
		const label = errorKind === "token-refresh" ? "token refresh" : "token exchange";
		throw new OAuthError(`${PROVIDER} ${label} failed: ${response.status} ${text.slice(0, 500)}`, {
			kind: errorKind,
			status: response.status,
		});
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new OAuthError(`${PROVIDER} token response was not JSON: ${text.slice(0, 500)}`, {
			kind: "validation",
			cause: error,
		});
	}
}

/**
 * @param {unknown} body
 * @param {{ refresh?: string }} [previous]
 * @param {number} [now]
 */
export function mapTokenResponse(body, previous, now = Date.now()) {
	const record = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
	const access = typeof record.access_token === "string" ? record.access_token : "";
	if (!access) {
		throw new OAuthError(`${PROVIDER} token response missing access token: ${JSON.stringify(body).slice(0, 500)}`, {
			kind: "validation",
		});
	}
	const seconds = record.expires_in;
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
		throw new OAuthError(`${PROVIDER} token response missing expires_in`, { kind: "validation" });
	}
	const refresh = typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : previous?.refresh ?? "";
	return {
		access,
		refresh,
		expires: now + seconds * 1000 - EXPIRY_SKEW_MS,
	};
}

/**
 * @param {string} code
 * @param {string} redirectUri
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function exchangeAuthorizationCode(code, redirectUri, options = {}) {
	let exchangeCode = code;
	const fragment = code.indexOf("#");
	if (fragment >= 0) exchangeCode = code.slice(0, fragment);
	const body = await postToken(
		{
			grant_type: "authorization_code",
			code: exchangeCode,
			redirect_uri: redirectUri,
		},
		options,
		"token-exchange",
	);
	return { body, credentials: mapTokenResponse(body) };
}

/**
 * @param {string} refreshToken
 * @param {{ refresh?: string }} [previous]
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function refreshAccessToken(refreshToken, previous, options = {}) {
	const body = await postToken(
		{
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		},
		options,
		"token-refresh",
	);
	return { body, credentials: mapTokenResponse(body, previous ?? { refresh: refreshToken }) };
}

/**
 * Userinfo failure leaves email unset. Login still continues.
 * @param {string} access
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function fetchUserEmail(access, options = {}) {
	throwIfCancelled(options.signal);
	try {
		const response = await (options.fetch ?? fetch)(USERINFO_URL, {
			headers: { Authorization: `Bearer ${access}` },
			signal: options.signal,
		});
		if (!response.ok) return undefined;
		const body = await response.json();
		return typeof body?.email === "string" && body.email ? body.email : undefined;
	} catch (error) {
		if (options.signal?.aborted) throw new LoginCancelledError();
		return undefined;
	}
}
