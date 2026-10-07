/** Login failure with a stable `kind` (`validation`, `provisioning`, `timeout`, …). */
export class OAuthError extends Error {
	/**
	 * @param {string} message
	 * @param {{ kind?: string, status?: number, cause?: unknown }} [options]
	 */
	constructor(message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "OAuthError";
		this.kind = options.kind;
		this.status = options.status;
	}
}

/** Cloud Code Assist rejected a model list or a generate call. */
export class AntigravityApiError extends Error {
	/**
	 * @param {string} message
	 * @param {{ kind?: string, status?: number, cause?: unknown }} [options]
	 */
	constructor(message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AntigravityApiError";
		this.kind = options.kind;
		this.status = options.status;
	}
}

/** The user aborted login, or the callback wait was cancelled. */
export class LoginCancelledError extends Error {
	/** @param {string} [message] */
	constructor(message = "Login cancelled") {
		super(message);
		this.name = "LoginCancelledError";
	}
}
