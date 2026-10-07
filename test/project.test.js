import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA } from "../src/config.js";
import { googleAntigravityProjectHook } from "../src/project.js";

const LOAD_CODE_ASSIST_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_USER_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";
const OPERATION_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal/operations/onboard-123";

function jsonResponse(body, status = 200, statusText = "OK") {
	return new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {{ sleep?: (ms: number) => Promise<void> }} [options]
 */
function discover(fetchImpl, options = {}) {
	return googleAntigravityProjectHook(
		{ access: "access-token", refresh: "refresh-token", expires: 0, email: "user@example.com" },
		{
			phase: "login",
			raw: { refresh_token: "refresh-token" },
			fetch: fetchImpl,
			sleep: options.sleep,
		},
	);
}

describe("Antigravity project discovery", () => {
	it("loads and refreshes an existing account through the daily endpoint", async () => {
		const payload = {
			currentTier: { id: "free-tier" },
			paidTier: { id: "standard-tier" },
			allowedTiers: [{ id: "free-tier" }],
			cloudaicompanionProject: "project-123",
		};
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push([url, init]);
			return jsonResponse(payload);
		};

		const credentials = await discover(fetchImpl);

		assert.equal(credentials.projectId, "project-123");
		assert.equal(calls.length, 2);
		for (const [url, init] of calls) {
			assert.equal(url, LOAD_CODE_ASSIST_URL);
			assert.equal(init?.method, "POST");
			assert.equal(init?.headers.Authorization, "Bearer access-token");
			assert.equal(init?.headers["Content-Type"], "application/json");
			assert.match(init?.headers["User-Agent"], /^antigravity\/hub\//);
			assert.deepEqual(JSON.parse(String(init?.body)), { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA });
		}
	});

	it("reloads with the returned project when paidTier is absent", async () => {
		const hydrated = {
			currentTier: { id: "free-tier" },
			paidTier: { id: "standard-tier" },
			allowedTiers: [{ id: "free-tier" }],
			cloudaicompanionProject: "project-123",
		};
		const responses = [
			{
				currentTier: { id: "free-tier" },
				allowedTiers: [{ id: "free-tier" }],
				cloudaicompanionProject: "project-123",
			},
			hydrated,
			hydrated,
		];
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push([url, init]);
			const payload = responses.shift();
			if (!payload) throw new Error("Unexpected Cloud Code Assist request");
			return jsonResponse(payload);
		};

		const credentials = await discover(fetchImpl);

		assert.equal(credentials.projectId, "project-123");
		assert.equal(calls.length, 3);
		assert.deepEqual(JSON.parse(String(calls[0][1]?.body)), { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA });
		assert.deepEqual(JSON.parse(String(calls[1][1]?.body)), {
			cloudaicompanionProject: "project-123",
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		});
		assert.deepEqual(JSON.parse(String(calls[2][1]?.body)), { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA });
	});

	it("onboards an account once with the free-tier request", async () => {
		const responses = [
			{ allowedTiers: [{ id: "free-tier" }] },
			{
				name: "operations/onboard-123",
				done: true,
				response: {
					"@type": "type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse",
					cloudaicompanionProject: "project-123",
				},
			},
			{
				currentTier: { id: "free-tier" },
				paidTier: { id: "standard-tier" },
				cloudaicompanionProject: "project-123",
			},
		];
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push([url, init]);
			const payload = responses.shift();
			if (!payload) throw new Error("Unexpected Cloud Code Assist request");
			return jsonResponse(payload);
		};

		const credentials = await discover(fetchImpl);

		assert.equal(credentials.projectId, "project-123");
		assert.equal(calls.length, 3);
		assert.equal(calls[1][0], ONBOARD_USER_URL);
		assert.equal(calls[1][1]?.method, "POST");
		assert.deepEqual(JSON.parse(String(calls[1][1]?.body)), {
			tierId: "free-tier",
			metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
		});
		assert.equal(calls[2][0], LOAD_CODE_ASSIST_URL);
	});

	it("polls a pending onboarding operation with GET after one second", async () => {
		const sleeps = [];
		const responses = [
			{ allowedTiers: [{ id: "free-tier" }] },
			{ name: "operations/onboard-123" },
			{
				name: "operations/onboard-123",
				done: true,
				response: {
					"@type": "type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse",
					cloudaicompanionProject: "project-123",
				},
			},
			{
				currentTier: { id: "free-tier" },
				paidTier: { id: "standard-tier" },
				cloudaicompanionProject: "project-123",
			},
		];
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push([url, init]);
			const payload = responses.shift();
			if (!payload) throw new Error("Unexpected Cloud Code Assist request");
			return jsonResponse(payload);
		};

		const credentials = await discover(fetchImpl, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});

		assert.equal(credentials.projectId, "project-123");
		assert.deepEqual(sleeps, [1000]);
		assert.equal(calls.length, 4);
		assert.equal(calls[2][0], OPERATION_URL);
		assert.equal(calls[2][1]?.method, "GET");
		assert.equal(calls[2][1]?.body, undefined);
		assert.equal(calls.filter(([url]) => url === ONBOARD_USER_URL).length, 1);
	});

	it("surfaces free-tier ineligibility without onboarding", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return jsonResponse({
				ineligibleTiers: [
					{
						tierId: "free-tier",
						reasonMessage: "This account is not eligible for the free tier.",
						validationUrl: "https://example.test/validate",
					},
				],
			});
		};

		await assert.rejects(discover(fetchImpl), /This account is not eligible for the free tier/);
		assert.equal(calls, 1);
	});

	it("rejects non-200 responses", async () => {
		const fetchImpl = async () => new Response("created", { status: 201, statusText: "Created" });
		await assert.rejects(discover(fetchImpl), /loadCodeAssist failed: 201/);
	});

	it("turns VALIDATION_REQUIRED into a sign-in message", async () => {
		const body = JSON.stringify({
			error: {
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: "https://example.test/validate" },
					},
				],
			},
		});
		const fetchImpl = async () => new Response(body, { status: 403, statusText: "Forbidden" });
		await assert.rejects(
			discover(fetchImpl),
			/Account verification required for user@example.com\. Visit https:\/\/example\.test\/validate to continue, then sign in again\./,
		);
	});

	it("refuses login when Google does not return a refresh token", async () => {
		await assert.rejects(
			googleAntigravityProjectHook(
				{ access: "access-token", refresh: "", expires: 0 },
				{ phase: "login", raw: {}, fetch: async () => jsonResponse({}) },
			),
			/No refresh token received/,
		);
	});

	it("keeps the stored project id on refresh without calling Cloud Code Assist", async () => {
		let calls = 0;
		const credentials = await googleAntigravityProjectHook(
			{ access: "new-access", refresh: "refresh-token", expires: 10 },
			{
				phase: "refresh",
				stored: { projectId: "project-123" },
				fetch: async () => {
					calls += 1;
					return jsonResponse({});
				},
			},
		);
		assert.equal(credentials.projectId, "project-123");
		assert.equal(calls, 0);
	});
});
