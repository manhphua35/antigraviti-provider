import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserCommand, windowsOpenerCommand } from "../src/open-browser.js";

const TARGET = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=http://127.0.0.1:51121/oauth-callback";

describe("browser opener", () => {
	it("uses PowerShell Start-Process on Windows so query separators stay intact", () => {
		const cmd = windowsOpenerCommand(TARGET, { existsSync: () => false, env: {} });
		assert.equal(cmd[0], "powershell.exe");
		assert.equal(cmd.includes("-EncodedCommand"), true);
		const script = Buffer.from(cmd.at(-1), "base64").toString("utf16le");
		assert.equal(script.includes(`Start-Process '${TARGET}'`), true);
		assert.equal(script.includes("&"), true);
	});

	it("uses xdg-open on Linux and wslview under WSL", () => {
		assert.deepEqual(browserCommand(TARGET, { platform: "linux", env: {}, isWsl: false }), ["xdg-open", TARGET]);
		assert.deepEqual(
			browserCommand(TARGET, { platform: "linux", env: {}, isWsl: true, commandExists: () => true }),
			["wslview", TARGET],
		);
		assert.deepEqual(
			browserCommand(TARGET, { platform: "linux", env: {}, isWsl: true, commandExists: () => false }),
			["xdg-open", TARGET],
		);
	});

	it("opens the real platform command without dropping the query string", () => {
		const cmd = browserCommand(TARGET, { env: {} });
		assert.ok(cmd);
		if (process.platform === "win32") {
			const script = Buffer.from(cmd.at(-1), "base64").toString("utf16le");
			assert.equal(script.includes(TARGET), true);
			assert.equal(cmd.includes("-EncodedCommand"), true);
		} else {
			assert.equal(cmd.at(-1), TARGET);
			assert.equal(cmd[0] === "xdg-open" || cmd[0] === "wslview" || cmd[0] === "open", true);
		}
	});

	it("skips the browser when BROWSER=none", () => {
		assert.equal(browserCommand(TARGET, { platform: "linux", env: { BROWSER: "none" } }), null);
	});
});
