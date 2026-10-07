import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCOPES, clientCredentials } from "../src/config.js";
import { buildAuthorizeUrl, generateState, mapTokenResponse } from "../src/oauth.js";

describe("Antigravity authorize URL", () => {
	it("generates a 16-byte hex CSRF state", () => {
		const state = generateState();
		assert.equal(typeof state, "string");
		assert.equal(state.length, 32);
		assert.match(state, /^[0-9a-f]{32}$/);
	});

	it("uses the authorization-code grant without PKCE", () => {
		const redirectUri = "http://127.0.0.1:51121/oauth-callback";
		const url = new URL(buildAuthorizeUrl({ redirectUri, state: "abc123" }));
		assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
		assert.equal(url.searchParams.get("response_type"), "code");
		assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
		assert.equal(url.searchParams.get("state"), "abc123");
		assert.equal(url.searchParams.get("scope"), SCOPES.join(" "));
		assert.equal(url.searchParams.get("access_type"), "offline");
		assert.equal(url.searchParams.get("prompt"), "consent");
		assert.equal(url.searchParams.has("code_challenge"), false);
		assert.equal(url.searchParams.has("code_verifier"), false);
		assert.equal(url.searchParams.get("client_id")?.endsWith(".apps.googleusercontent.com"), true);
	});

	it("decodes the installed-app client", () => {
		const { clientId, clientSecret } = clientCredentials();
		assert.equal(clientId.endsWith(".apps.googleusercontent.com"), true);
		assert.equal(clientSecret.startsWith("GOCSPX-"), true);
	});
});

describe("token response mapping", () => {
	it("applies the five-minute expiry skew and keeps a missing refresh token", () => {
		const now = 1_700_000_000_000;
		const mapped = mapTokenResponse({ access_token: "access", expires_in: 3600 }, { refresh: "old-refresh" }, now);
		assert.equal(mapped.access, "access");
		assert.equal(mapped.refresh, "old-refresh");
		assert.equal(mapped.expires, now + 3600 * 1000 - 300_000);
	});

	it("stores a rotated refresh token", () => {
		const mapped = mapTokenResponse(
			{ access_token: "access", refresh_token: "new-refresh", expires_in: 60 },
			{ refresh: "old-refresh" },
			0,
		);
		assert.equal(mapped.refresh, "new-refresh");
	});

	it("rejects a body with no access token", () => {
		assert.throws(() => mapTokenResponse({ expires_in: 60 }, undefined, 0), /missing access token/);
	});
});
