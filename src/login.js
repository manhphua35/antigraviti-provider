/**
 * Antigravity login:
 *   1. Listen on http://127.0.0.1:51121/oauth-callback
 *   2. Open Google's authorize URL (Windows or Linux browser)
 *   3. Exchange the code, read the account email
 *   4. Discover or provision the Cloud Code Assist project
 *   5. Save the OAuth credential
 *
 * The browser callback and a pasted redirect URL race. Whichever arrives first wins.
 */
import { CALLBACK_TIMEOUT_MS, LOGIN_INSTRUCTIONS, PROVIDER } from "./config.js";
import { parseCallbackInput, startCallbackServer } from "./callback.js";
import { LoginCancelledError, OAuthError } from "./errors.js";
import { openBrowser } from "./open-browser.js";
import { exchangeAuthorizationCode, fetchUserEmail, generateState, refreshAccessToken, buildAuthorizeUrl } from "./oauth.js";
import { googleAntigravityProjectHook } from "./project.js";
import { saveCredentials } from "./store.js";
import { ensureAntigravityVersion } from "./user-agent.js";

/**
 * @param {(signal: AbortSignal) => Promise<string>} readManualCode
 * @param {string} expectedState
 * @param {AbortSignal} signal
 */
async function readManualCodeLoop(readManualCode, expectedState, signal) {
	while (!signal.aborted) {
		let input;
		try {
			input = await readManualCode(signal);
		} catch (error) {
			if (signal.aborted) throw new LoginCancelledError();
			throw error;
		}
		const parsed = parseCallbackInput(input ?? "");
		if (!parsed.code) continue;
		if (expectedState && parsed.state && parsed.state !== expectedState) continue;
		return { code: parsed.code, state: parsed.state ?? "" };
	}
	throw new LoginCancelledError();
}

/**
 * @param {{
 *   openBrowser?: boolean,
 *   port?: number,
 *   allowPortFallback?: boolean,
 *   timeoutMs?: number,
 *   save?: boolean,
 *   credentialPath?: string,
 *   fetch?: typeof fetch,
 *   signal?: AbortSignal,
 *   onProgress?: (message: string) => void,
 *   onAuth?: (info: { url: string, launchUrl?: string, instructions?: string }) => void,
 *   readManualCode?: (signal: AbortSignal) => Promise<string>,
 * }} [options]
 */
export async function loginAntigravity(options = {}) {
	const onProgress = options.onProgress ?? (() => {});
	const fetchImpl = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
	const state = generateState();
	const timeout = createTimeout(timeoutMs);
	const signals = [timeout.signal, options.signal].filter(Boolean);
	const signal = AbortSignal.any(signals);

	const versionPromise = ensureAntigravityVersion(fetchImpl, signal).catch(() => {});

	const server = await startCallbackServer({
		preferredPort: options.port,
		expectedState: state,
		allowPortFallback: options.allowPortFallback,
		onProgress,
	});

	const manualAbort = new AbortController();
	const stopManual = () => {
		if (!manualAbort.signal.aborted) manualAbort.abort("callback settled");
	};

	try {
		const authUrl = buildAuthorizeUrl({ redirectUri: server.redirectUri, state });
		server.setAuthUrl(authUrl);
		const info = {
			url: authUrl,
			launchUrl: server.launchUrl,
			instructions: LOGIN_INSTRUCTIONS,
		};
		options.onAuth?.(info);
		if (options.openBrowser !== false) openBrowser(authUrl);
		onProgress("Waiting for browser authentication...");

		/** @type {Promise<{ code: string, state: string }>} */
		let manualPromise = new Promise(() => {});
		if (options.readManualCode) {
			const read = options.readManualCode;
			manualPromise = readManualCodeLoop(read, state, manualAbort.signal).catch((error) => {
				if (manualAbort.signal.aborted && !signal.aborted) return new Promise(() => {});
				throw error;
			});
			// The paste prompt loses the race when the browser callback arrives first.
			// Catch that late rejection so it does not become an unhandled rejection.
			manualPromise.catch(() => {});
		}

		const callback = await Promise.race([server.waitForCallback(signal), manualPromise]);
		stopManual();
		onProgress("Exchanging authorization code for tokens...");
		const exchanged = await exchangeAuthorizationCode(callback.code, server.redirectUri, {
			fetch: fetchImpl,
			signal,
		});
		const email = await fetchUserEmail(exchanged.credentials.access, { fetch: fetchImpl, signal });
		await versionPromise;
		const withProject = await googleAntigravityProjectHook(
			{ ...exchanged.credentials, email },
			{
				phase: "login",
				raw: exchanged.body,
				onProgress,
				signal,
				fetch: fetchImpl,
			},
		);
		const credential = {
			type: "oauth",
			provider: PROVIDER,
			access: withProject.access,
			refresh: withProject.refresh,
			expires: withProject.expires,
			email: withProject.email,
			projectId: withProject.projectId,
			authorizedAt: Date.now(),
		};
		if (options.save !== false) {
			credential.credentialPath = saveCredentials(credential, options.credentialPath);
		}
		return credential;
	} finally {
		timeout.cancel();
		stopManual();
		await server.stop();
	}
}

/**
 * Timeout that does not keep the process alive after login finishes.
 * @param {number} ms
 */
function createTimeout(ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		const error = new Error(`Timed out after ${ms}ms waiting for browser authentication`);
		error.name = "TimeoutError";
		controller.abort(error);
	}, ms);
	timer.unref?.();
	return {
		signal: controller.signal,
		cancel() {
			clearTimeout(timer);
		},
	};
}

/**
 * Refresh an access token and keep the stored project id.
 * @param {{ access?: string, refresh: string, expires?: number, email?: string, projectId?: string, authorizedAt?: number }} stored
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function refreshAntigravity(stored, options = {}) {
	if (!stored?.projectId) {
		throw new OAuthError(`${PROVIDER} credentials are missing projectId; sign in again`, { kind: "configuration" });
	}
	if (!stored.refresh) {
		throw new OAuthError(`${PROVIDER} credentials are missing a refresh token; sign in again`, { kind: "configuration" });
	}
	const refreshed = await refreshAccessToken(stored.refresh, stored, options);
	const withProject = await googleAntigravityProjectHook(refreshed.credentials, {
		phase: "refresh",
		raw: refreshed.body,
		stored,
		fetch: options.fetch,
		signal: options.signal,
	});
	return {
		type: "oauth",
		provider: PROVIDER,
		access: withProject.access,
		refresh: withProject.refresh,
		expires: withProject.expires,
		email: withProject.email || stored.email,
		projectId: withProject.projectId,
		authorizedAt: stored.authorizedAt,
	};
}
