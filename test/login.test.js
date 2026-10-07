import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loginAntigravity, refreshAntigravity } from "../src/login.js";
import { loadCredentials } from "../src/store.js";

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("loginAntigravity", () => {
	it("exchanges a pasted code, discovers the project, and saves the credential", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-login-"));
		const file = path.join(dir, "credentials.json");
		const calls = [];
		let redirectUri = "";

		const fetchImpl = async (url, init) => {
			const href = String(url);
			calls.push({ href, init });
			if (href.includes("manifest")) return new Response("version: 2.8.0\n");
			if (href.includes("/token")) {
				const params = new URLSearchParams(String(init?.body));
				assert.equal(params.get("grant_type"), "authorization_code");
				assert.equal(params.get("code"), "pasted-code");
				assert.equal(params.get("redirect_uri"), redirectUri);
				assert.equal(params.has("code_verifier"), false);
				assert.equal(params.get("client_id")?.endsWith(".apps.googleusercontent.com"), true);
				return json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
			}
			if (href.includes("userinfo")) return json({ email: "user@example.com" });
			if (href.includes("loadCodeAssist")) {
				return json({
					currentTier: { id: "free-tier" },
					paidTier: { id: "standard-tier" },
					allowedTiers: [{ id: "free-tier" }],
					cloudaicompanionProject: "project-123",
				});
			}
			throw new Error(`unexpected ${href}`);
		};

		const credential = await loginAntigravity({
			openBrowser: false,
			port: 0,
			credentialPath: file,
			fetch: fetchImpl,
			onProgress() {},
			onAuth(info) {
				redirectUri = new URL(info.url).searchParams.get("redirect_uri") ?? "";
				assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/);
				assert.equal(info.launchUrl?.endsWith("/launch"), true);
			},
			readManualCode: async () => "pasted-code",
		});

		assert.equal(credential.email, "user@example.com");
		assert.equal(credential.projectId, "project-123");
		assert.equal(credential.refresh, "refresh-token");
		assert.equal(credential.credentialPath, file);
		const stored = loadCredentials(file);
		assert.equal(stored.projectId, "project-123");
		assert.equal(stored.email, "user@example.com");
		assert.equal(calls.some((call) => call.href.includes("loadCodeAssist")), true);
	});

	it("refreshes the access token and keeps the project id", async () => {
		const fetchImpl = async (url, init) => {
			const params = new URLSearchParams(String(init?.body));
			assert.equal(params.get("grant_type"), "refresh_token");
			assert.equal(params.get("refresh_token"), "refresh-token");
			return json({ access_token: "new-access", expires_in: 3600 });
		};
		const credential = await refreshAntigravity(
			{
				access: "old-access",
				refresh: "refresh-token",
				expires: 1,
				email: "user@example.com",
				projectId: "project-123",
				authorizedAt: 10,
			},
			{ fetch: fetchImpl },
		);
		assert.equal(credential.access, "new-access");
		assert.equal(credential.refresh, "refresh-token");
		assert.equal(credential.projectId, "project-123");
		assert.equal(credential.email, "user@example.com");
		assert.equal(credential.authorizedAt, 10);
	});
});
