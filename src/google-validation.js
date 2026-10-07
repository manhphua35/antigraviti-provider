/**
 * Google sometimes answers Cloud Code Assist with VALIDATION_REQUIRED and a
 * URL the account must visit before login can finish.
 */

/** @param {string} errorBody */
export function extractGoogleValidationUrl(errorBody) {
	if (!errorBody.includes("VALIDATION_REQUIRED")) return undefined;
	const start = errorBody.indexOf("{");
	if (start === -1) return undefined;
	try {
		const parsed = JSON.parse(errorBody.slice(start));
		const details = parsed?.error?.details;
		if (!Array.isArray(details)) return undefined;
		const detail = details.find(
			(entry) => entry?.reason === "VALIDATION_REQUIRED" && typeof entry?.metadata?.validation_url === "string",
		);
		return detail?.metadata?.validation_url;
	} catch {
		return undefined;
	}
}

/**
 * @param {string} validationUrl
 * @param {string} nextAction
 * @param {string} [email]
 */
export function formatGoogleValidationRequiredMessage(validationUrl, nextAction, email) {
	const account = email ? ` for ${email}` : "";
	return `Account verification required${account}. Visit ${validationUrl} to continue, then ${nextAction}.`;
}
