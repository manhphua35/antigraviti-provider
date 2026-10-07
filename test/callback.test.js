import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { parseCallbackInput, startCallbackServer } from "../src/callback.js";

describe("parseCallbackInput", () => {
	it("reads a redirect URL, a query string, and a raw code", () => {
		assert.deepEqual(parseCallbackInput("http://127.0.0.1:51121/oauth-callback?code=abc&state=xyz"), {
			code: "abc",
			state: "xyz",
		});
		assert.deepEqual(parseCallbackInput("?code=abc&state=xyz"), { code: "abc", state: "xyz" });
		assert.deepEqual(parseCallbackInput("abc#xyz"), { code: "abc", state: "xyz" });
		assert.deepEqual(parseCallbackInput("   "), {});
	});
});

/** @param {string} url */
function get(url) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
	});
}

describe("loopback callback server", () => {
	it("redirects /launch and accepts the matching OAuth callback", async () => {
		const server = await startCallbackServer({ preferredPort: 0, expectedState: "state-1" });
		try {
			assert.match(server.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/);
			server.setAuthUrl("https://accounts.google.com/o/oauth2/v2/auth?state=state-1");

			const launch = await get(server.launchUrl);
			assert.equal(launch.status, 302);
			assert.equal(launch.headers.location, "https://accounts.google.com/o/oauth2/v2/auth?state=state-1");

			const mismatch = await get(`${server.redirectUri}?code=nope&state=other`);
			assert.equal(mismatch.status, 500);
			assert.match(mismatch.body, /State mismatch/);

			const pending = server.waitForCallback();
			const ok = await get(`${server.redirectUri}?code=good-code&state=state-1`);
			assert.equal(ok.status, 200);
			assert.match(ok.body, /Signed in/);
			assert.deepEqual(await pending, { code: "good-code", state: "state-1" });
		} finally {
			await server.stop();
		}
	});

	it("rejects a consent denial that carries our state", async () => {
		const server = await startCallbackServer({ preferredPort: 0, expectedState: "state-2" });
		try {
			const pending = assert.rejects(server.waitForCallback(), /Authorization failed: access_denied/);
			const denied = await get(`${server.redirectUri}?error=access_denied&state=state-2`);
			assert.equal(denied.status, 500);
			await pending;
		} finally {
			await server.stop();
		}
	});
});
