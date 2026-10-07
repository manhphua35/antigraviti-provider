/**
 * Loopback OAuth callback on 127.0.0.1.
 * The browser is redirected to `/oauth-callback`. `/launch` redirects to the
 * authorize URL so a short link can be copied when the full URL wraps.
 */
import http from "node:http";
import { CALLBACK_HOSTNAME, CALLBACK_PATH, CALLBACK_PORT, LAUNCH_PATH } from "./config.js";
import { LoginCancelledError, OAuthError } from "./errors.js";

/**
 * Accept a raw code, a `code#state` pair, a query string, or a full redirect URL.
 * @param {string} input
 * @returns {{ code?: string, state?: string }}
 */
export function parseCallbackInput(input) {
	const value = String(input ?? "").trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL. Fall through to query-string and raw-code forms.
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	const [code, state] = value.split("#", 2);
	return { code, state };
}

function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** @param {{ ok?: boolean, error?: string }} state */
function resultPage(state) {
	const ok = state.ok === true;
	const title = ok ? "Signed in" : "Sign-in failed";
	const detail = ok
		? "Antigravity login completed. You can close this window."
		: escapeHtml(state.error || "Authorization failed");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font: 16px/1.5 sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #16141c; color: #f4f1ea; }
  main { max-width: 36rem; padding: 2rem; }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; color: ${ok ? "#8dcea0" : "#e07a6a"}; }
  p { margin: 0; color: #d9d3c8; }
</style>
</head>
<body><main><h1>${title}</h1><p>${detail}</p></main></body>
</html>`;
}

/**
 * @param {{
 *   preferredPort?: number,
 *   hostname?: string,
 *   callbackPath?: string,
 *   expectedState: string,
 *   allowPortFallback?: boolean,
 *   onProgress?: (message: string) => void,
 * }} options
 */
export function startCallbackServer(options) {
	const preferredPort = options.preferredPort ?? CALLBACK_PORT;
	const hostname = options.hostname ?? CALLBACK_HOSTNAME;
	const callbackPath = options.callbackPath ?? CALLBACK_PATH;
	const allowPortFallback = options.allowPortFallback ?? true;
	const expectedState = options.expectedState;

	/** @type {{ resolve: (value: { code: string, state: string }) => void, reject: (error: Error) => void } | undefined} */
	let waiter;
	let pendingAuthUrl;
	/** @type {http.Server | undefined} */
	let server;

	const callbackPromise = new Promise((resolve, reject) => {
		waiter = { resolve, reject };
	});
	// A callback may never arrive. That must not surface as an unhandled rejection
	// when login finishes by paste instead.
	callbackPromise.catch(() => {});

	/**
	 * @param {http.IncomingMessage} req
	 * @param {http.ServerResponse} res
	 */
	function handle(req, res) {
		const url = new URL(req.url ?? "/", `http://${hostname}`);
		if (url.pathname !== callbackPath) {
			if (url.pathname === LAUNCH_PATH) {
				if (!pendingAuthUrl) {
					res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("OAuth launch URL is no longer active");
					return;
				}
				res.writeHead(302, { Location: pendingAuthUrl });
				res.end();
				return;
			}
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
			return;
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") || "";
		const error = url.searchParams.get("error") || "";
		const errorDescription = url.searchParams.get("error_description") || error;

		/** @type {{ ok: true, code: string, state: string } | { ok?: false, error?: string }} */
		let resultState;
		if (error) {
			resultState = { ok: false, error: `Authorization failed: ${errorDescription}` };
		} else if (!code) {
			resultState = { ok: false, error: "Missing authorization code" };
		} else if (expectedState && state !== expectedState) {
			resultState = { ok: false, error: "State mismatch - possible CSRF attack" };
		} else {
			resultState = { ok: true, code, state };
		}

		if (resultState.ok) {
			waiter?.resolve({ code: resultState.code, state: resultState.state });
		} else if (error && (!expectedState || state === expectedState)) {
			// A matching state means this redirect came from our authorize request.
			// Errors without that state are ignored so another local process cannot
			// fail the login by hitting the callback.
			waiter?.reject(new OAuthError(resultState.error ?? `Authorization failed: ${errorDescription}`, { kind: "device-auth" }));
		}

		const body = resultPage(resultState);
		res.writeHead(resultState.ok ? 200 : 500, { "Content-Type": "text/html; charset=utf-8" });
		res.end(body);
	}

	/**
	 * @param {number} port
	 * @param {boolean} fallback
	 */
	function listen(port, fallback) {
		const listening = http.createServer(handle);
		listening.once("error", (error) => {
			const code = /** @type {NodeJS.ErrnoException} */ (error).code;
			if (code === "EADDRINUSE" && fallback && port !== 0) {
				options.onProgress?.(
					`Preferred port ${preferredPort} is in use, so this login is using another port. If Google rejects the redirect, free port ${preferredPort} and run login again.`,
				);
				listen(0, false);
				return;
			}
			if (code === "EADDRINUSE" && !fallback) {
				waiter?.reject(
					new OAuthError(
						`OAuth callback port ${preferredPort} is in use. Free that port and run login again.`,
						{ kind: "configuration", cause: error },
					),
				);
				return;
			}
			waiter?.reject(error instanceof Error ? error : new Error(String(error)));
		});
		listening.listen(port, hostname, () => {
			server = listening;
			const address = listening.address();
			const actualPort = address && typeof address === "object" ? address.port : port;
			const redirectUri = `http://${hostname}:${actualPort}${callbackPath}`;
			const launchUrl = callbackPath === LAUNCH_PATH ? undefined : `http://${hostname}:${actualPort}${LAUNCH_PATH}`;
			ready({ server: listening, redirectUri, launchUrl, port: actualPort });
		});
	}

	/** @type {(value: CallbackServer) => void} */
	let ready = () => {};
	/** @type {(error: Error) => void} */
	let failed = () => {};
	const started = new Promise((resolve, reject) => {
		ready = resolve;
		failed = reject;
	});

	listen(preferredPort, allowPortFallback);
	callbackPromise.catch((error) => {
		if (!server) failed(error instanceof Error ? error : new Error(String(error)));
	});

	return started.then((handle) => ({
		...handle,
		/** @param {string} url */
		setAuthUrl(url) {
			pendingAuthUrl = url;
		},
		/**
		 * Resolves with the browser redirect. Rejects when the user denies consent
		 * or when `signal` aborts (timeout or cancel).
		 * @param {AbortSignal} [signal]
		 */
		waitForCallback(signal) {
			if (signal?.aborted) return Promise.reject(abortError(signal));
			return new Promise((resolve, reject) => {
				const onAbort = () => reject(abortError(signal));
				signal?.addEventListener("abort", onAbort, { once: true });
				callbackPromise.then(
					(value) => {
						signal?.removeEventListener("abort", onAbort);
						resolve(value);
					},
					(error) => {
						signal?.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
			});
		},
		async stop() {
			pendingAuthUrl = undefined;
			const current = server;
			server = undefined;
			if (!current) return;
			current.closeAllConnections?.();
			if (!current.listening) return;
			await new Promise((resolve, reject) => {
				current.close((error) => (error ? reject(error) : resolve(undefined)));
			});
		},
	}));
}

/** @param {AbortSignal | undefined} signal */
function abortError(signal) {
	if (signal?.reason?.name === "TimeoutError") {
		return new OAuthError("Timed out waiting for browser authentication", { kind: "timeout" });
	}
	const reason = signal?.reason;
	const detail = reason instanceof Error ? reason.message : reason ? String(reason) : "";
	return new LoginCancelledError(detail ? `Login cancelled: ${detail}` : "Login cancelled");
}

export { CALLBACK_PORT };
