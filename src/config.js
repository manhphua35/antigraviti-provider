/**
 * Installed-app login settings for `google-antigravity`.
 * Client id and secret are the public OAuth client, stored base64 the same way
 * oh-my-pi stores them, and decoded at runtime.
 */

export const PROVIDER = "google-antigravity";

export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
export const CLOUD_CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
/** Sandbox twin used when the daily Cloud Code Assist endpoint fails over. */
export const CLOUD_CODE_ASSIST_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const CALLBACK_PORT = 51121;
export const CALLBACK_PATH = "/oauth-callback";
export const CALLBACK_HOSTNAME = "127.0.0.1";
export const LAUNCH_PATH = "/launch";

export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

/** Access tokens are treated as expired this long before `expires_in` elapses. */
export const EXPIRY_SKEW_MS = 300_000;
/** How long the loopback callback waits for the browser. */
export const CALLBACK_TIMEOUT_MS = 300_000;
/** Per-request timeout for token exchange and Cloud Code Assist calls. */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export const FREE_TIER_ID = "free-tier";
export const ONBOARD_TIMEOUT_MS = 30_000;
export const ONBOARD_POLL_INTERVAL_MS = 1_000;

/** Metadata the native Antigravity client sends on control-plane calls. */
export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
	ideType: "ANTIGRAVITY",
});

export const LOGIN_INSTRUCTIONS = "Complete the sign-in in your browser.";

const CLIENT_ID_B64 =
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==";
const CLIENT_SECRET_B64 = "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=";

function decodeBase64(value) {
	return Buffer.from(value, "base64").toString("utf8");
}

/** Google OAuth client used by the Antigravity installed-app login. */
export function clientCredentials() {
	return {
		clientId: decodeBase64(CLIENT_ID_B64),
		clientSecret: decodeBase64(CLIENT_SECRET_B64),
	};
}
