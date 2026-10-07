import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	accountFileName,
	accountFilePath,
	isQuotaError,
	listAccounts,
	loadAccountsIndex,
	markQuotaExhausted,
	removeAccount,
	resetAccountQuota,
	rotateToNextAvailableAccount,
	saveAccountsIndex,
	switchActiveAccount,
	upsertAccount,
} from "../src/accounts.js";
import { createChatServer, listen } from "../src/server.js";
import { loadCredentials, saveCredentials } from "../src/store.js";
import { AntigravityApiError } from "../src/errors.js";

function setupTestEnv() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-accounts-test-"));
	const accountsDir = path.join(dir, "accounts");
	const indexPath = path.join(dir, "accounts.json");
	const credentialPath = path.join(dir, "credentials.json");
	return { dir, accountsDir, indexPath, credentialPath };
}

describe("accounts filenames", () => {
	it("sanitizes emails for filenames", () => {
		assert.equal(accountFileName("test@gmail.com"), "test@gmail.com.json");
		assert.equal(accountFileName("TEST.User+1@gmail.com"), "test.user+1@gmail.com.json");
		assert.equal(accountFileName("bad:email/test@domain.com"), "bad_email_test@domain.com.json");
	});
});

describe("multi-account management", () => {
	it("auto-saves new accounts to separate files and syncs active credentials", () => {
		const env = setupTestEnv();
		try {
			const cred1 = {
				email: "user1@gmail.com",
				projectId: "proj-1",
				access: "token-1",
				refresh: "ref-1",
				expires: Date.now() + 3600_000,
			};
			const res1 = upsertAccount(cred1, env);
			assert.equal(res1.isNewAccount, true);
			assert.equal(res1.previousActive, null);
			assert.equal(res1.active, "user1@gmail.com");
			assert.equal(fs.existsSync(res1.file), true);

			const saved1 = loadCredentials(res1.file);
			assert.equal(saved1.email, "user1@gmail.com");

			const active1 = loadCredentials(env.credentialPath);
			assert.equal(active1.email, "user1@gmail.com");

			// Login with a DIFFERENT gmail
			const cred2 = {
				email: "user2@gmail.com",
				projectId: "proj-2",
				access: "token-2",
				refresh: "ref-2",
				expires: Date.now() + 3600_000,
			};
			const res2 = upsertAccount(cred2, env);
			assert.equal(res2.isNewAccount, true);
			assert.equal(res2.previousActive, "user1@gmail.com");
			assert.equal(res2.active, "user2@gmail.com");
			assert.equal(fs.existsSync(res2.file), true);

			// Both separate files exist independently
			assert.equal(fs.existsSync(res1.file), true);
			assert.equal(fs.existsSync(res2.file), true);

			// Active credentials file synced to user2
			const active2 = loadCredentials(env.credentialPath);
			assert.equal(active2.email, "user2@gmail.com");

			// List accounts returns both
			const list = listAccounts(env);
			assert.equal(list.length, 2);
			const u1 = list.find((a) => a.email === "user1@gmail.com");
			const u2 = list.find((a) => a.email === "user2@gmail.com");
			assert.equal(u1.isActive, false);
			assert.equal(u2.isActive, true);
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("auto-imports existing credentials.json into accounts list", () => {
		const env = setupTestEnv();
		try {
			const existingCred = {
				email: "legacy@gmail.com",
				projectId: "legacy-proj",
				access: "leg-token",
				refresh: "leg-refresh",
				expires: Date.now() + 3600_000,
			};
			saveCredentials(existingCred, env.credentialPath);

			const accounts = listAccounts(env);
			assert.equal(accounts.length, 1);
			assert.equal(accounts[0].email, "legacy@gmail.com");
			assert.equal(accounts[0].isActive, true);

			// Verify dedicated file was created for it
			assert.equal(fs.existsSync(accountFilePath("legacy@gmail.com", env.accountsDir)), true);
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("switches active account and updates credentials.json", () => {
		const env = setupTestEnv();
		try {
			upsertAccount({ email: "a@gmail.com", projectId: "p-a", access: "t-a", refresh: "r-a" }, env);
			upsertAccount({ email: "b@gmail.com", projectId: "p-b", access: "t-b", refresh: "r-b" }, env);

			// Currently b is active
			assert.equal(loadCredentials(env.credentialPath).email, "b@gmail.com");

			// Switch to a
			const switched = switchActiveAccount("a@gmail.com", env);
			assert.equal(switched.email, "a@gmail.com");
			assert.equal(loadCredentials(env.credentialPath).email, "a@gmail.com");

			const list = listAccounts(env);
			assert.equal(list.find((x) => x.email === "a@gmail.com").isActive, true);
			assert.equal(list.find((x) => x.email === "b@gmail.com").isActive, false);
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("treats email case as the same account", () => {
		const env = setupTestEnv();
		try {
			const first = upsertAccount(
				{ email: "User@gmail.com", projectId: "p", access: "t1", refresh: "r", expires: Date.now() + 1000 },
				env,
			);
			const second = upsertAccount(
				{ email: "user@gmail.com", projectId: "p", access: "t2", refresh: "r", expires: Date.now() + 1000 },
				env,
			);
			assert.equal(first.email, "user@gmail.com");
			assert.equal(second.isNewAccount, false);
			assert.equal(listAccounts(env).length, 1);
			assert.equal(loadCredentials(env.credentialPath).access, "t2");
			assert.equal(loadCredentials(first.file).access, "t2");
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("removes account and deletes its file", () => {
		const env = setupTestEnv();
		try {
			upsertAccount({ email: "a@gmail.com", projectId: "p-a", access: "t-a", refresh: "r-a" }, env);
			upsertAccount({ email: "b@gmail.com", projectId: "p-b", access: "t-b", refresh: "r-b" }, env);

			const fileA = accountFilePath("a@gmail.com", env.accountsDir);
			assert.equal(fs.existsSync(fileA), true);

			removeAccount("a@gmail.com", env);
			assert.equal(fs.existsSync(fileA), false);

			const list = listAccounts(env);
			assert.equal(list.length, 1);
			assert.equal(list[0].email, "b@gmail.com");
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});
});

describe("auto-quota rotation", () => {
	it("identifies quota errors accurately", () => {
		assert.equal(isQuotaError(new AntigravityApiError("Rate limit exceeded", { status: 429 })), true);
		assert.equal(isQuotaError(new Error("RESOURCE_EXHAUSTED: quota exceeded for 5-hour window")), true);
		assert.equal(isQuotaError(new Error("User has reached the limit for free tier")), true);
		assert.equal(isQuotaError(new Error("Connection reset by peer")), false);
		assert.equal(isQuotaError(null), false);
	});

	it("rotates to next available account when quota exhausted", () => {
		const env = setupTestEnv();
		try {
			upsertAccount({ email: "a@gmail.com", projectId: "p-a", access: "t-a", refresh: "r-a" }, env);
			upsertAccount({ email: "b@gmail.com", projectId: "p-b", access: "t-b", refresh: "r-b" }, env);
			upsertAccount({ email: "c@gmail.com", projectId: "p-c", access: "t-c", refresh: "r-c" }, env);

			switchActiveAccount("a@gmail.com", env);
			assert.equal(loadCredentials(env.credentialPath).email, "a@gmail.com");

			// Account a hits quota limit
			markQuotaExhausted("a@gmail.com", env);
			const rot1 = rotateToNextAvailableAccount("a@gmail.com", env);
			assert.equal(rot1.rotated, true);
			assert.equal(rot1.newEmail, "b@gmail.com");
			assert.equal(loadCredentials(env.credentialPath).email, "b@gmail.com");

			// Account b also hits quota limit
			markQuotaExhausted("b@gmail.com", env);
			const rot2 = rotateToNextAvailableAccount("b@gmail.com", env);
			assert.equal(rot2.rotated, true);
			assert.equal(rot2.newEmail, "c@gmail.com");
			assert.equal(loadCredentials(env.credentialPath).email, "c@gmail.com");

			markQuotaExhausted("b@gmail.com", env);
			switchActiveAccount("a@gmail.com", env);
			const skipped = rotateToNextAvailableAccount("a@gmail.com", env);
			assert.equal(skipped.rotated, true);
			assert.equal(skipped.newEmail, "c@gmail.com");

			// Reset quota works
			resetAccountQuota("a@gmail.com", env);
			const list = listAccounts(env);
			assert.equal(list.find((x) => x.email === "a@gmail.com").quotaStatus, "ok");
			assert.equal(list.find((x) => x.email === "b@gmail.com").quotaStatus, "exhausted");
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("HTTP server automatically rotates to next account when 429 occurs", async () => {
		const env = setupTestEnv();
		try {
			upsertAccount({ email: "acc1@gmail.com", projectId: "p-1", access: "t-1", refresh: "r-1" }, env);
			upsertAccount({ email: "acc2@gmail.com", projectId: "p-2", access: "t-2", refresh: "r-2" }, env);
			switchActiveAccount("acc1@gmail.com", env);

			const rotatedEvents = [];
			const calls = [];

			const mockGenerate = async (options) => {
				calls.push(options.credential.email);
				if (options.credential.email === "acc1@gmail.com") {
					throw new AntigravityApiError("RESOURCE_EXHAUSTED", { status: 429 });
				}
				return {
					text: "Success from acc2",
					thinking: "",
					toolCalls: [],
					stopReason: "stop",
					usage: { input: 1, output: 1, totalTokens: 2 },
					effort: "medium",
					wireModelId: "gemini-3.8-flash-medium",
				};
			};

			const server = createChatServer({
				apiKey: "test-key",
				credentialPath: env.credentialPath,
				accountsDir: env.accountsDir,
				accountsIndexPath: env.indexPath,
				loadCredential: () => loadCredentials(env.credentialPath),
				generate: mockGenerate,
				onRotate(info) {
					rotatedEvents.push(info);
				},
			});

			const address = await listen(server, { host: "127.0.0.1", port: 0 });

			try {
				const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer test-key",
					},
					body: JSON.stringify({
						messages: [{ role: "user", content: "Hello" }],
					}),
				});

				assert.equal(response.status, 200);
				const body = await response.json();
				assert.equal(body.choices[0].message.content, "Success from acc2");

				// Verified rotation occurred
				assert.deepEqual(calls, ["acc1@gmail.com", "acc2@gmail.com"]);
				assert.equal(rotatedEvents.length, 1);
				assert.equal(rotatedEvents[0].from, "acc1@gmail.com");
				assert.equal(rotatedEvents[0].to, "acc2@gmail.com");

				// Active account updated in credentials.json
				assert.equal(loadCredentials(env.credentialPath).email, "acc2@gmail.com");
			} finally {
				await new Promise((resolve) => server.close(resolve));
			}
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});

	it("stops rotating and returns 429 when all registered accounts are exhausted", async () => {
		const env = setupTestEnv();
		try {
			upsertAccount({ email: "acc1@gmail.com", projectId: "p-1", access: "t-1", refresh: "r-1" }, env);
			upsertAccount({ email: "acc2@gmail.com", projectId: "p-2", access: "t-2", refresh: "r-2" }, env);
			switchActiveAccount("acc1@gmail.com", env);

			const calls = [];
			const mockGenerate = async (options) => {
				calls.push(options.credential.email);
				throw new AntigravityApiError("RESOURCE_EXHAUSTED", { status: 429 });
			};

			const server = createChatServer({
				apiKey: "test-key",
				credentialPath: env.credentialPath,
				accountsDir: env.accountsDir,
				accountsIndexPath: env.indexPath,
				loadCredential: () => loadCredentials(env.credentialPath),
				generate: mockGenerate,
			});

			const address = await listen(server, { host: "127.0.0.1", port: 0 });

			try {
				const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer test-key",
					},
					body: JSON.stringify({
						messages: [{ role: "user", content: "Hello" }],
					}),
				});

				assert.equal(response.status, 429);
				// Verified each account was tried once and stopped without infinite loop
				assert.deepEqual(calls, ["acc1@gmail.com", "acc2@gmail.com"]);
			} finally {
				await new Promise((resolve) => server.close(resolve));
			}
		} finally {
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});
});
