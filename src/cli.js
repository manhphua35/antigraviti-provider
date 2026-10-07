#!/usr/bin/env node
/**
 * Antigravity login and Cloud Code Assist calls for Windows and Linux.
 *
 *   node src/cli.js login
 *   node src/cli.js models
 *   node src/cli.js generate --model gemini-3.1-pro --effort high --prompt "Hello"
 *   node src/cli.js serve
 */
import fs from "node:fs";
import readline from "node:readline";
import { defaultApiKeyPath, resolveServerApiKey } from "./api-key.js";
import { DEFAULT_SERVER_EFFORT, SERVER_MODEL_ID } from "./chat.js";
import { generateAntigravity, listAntigravityModels } from "./generate.js";
import { loginAntigravity, refreshAntigravity } from "./login.js";
import { ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT, DEFAULT_MODEL_ID } from "./models.js";
import { createChatServer, listen } from "./server.js";
import { sessionPathFor } from "./session.js";
import { defaultCredentialPath, loadCredentials, saveCredentials } from "./store.js";

const HELP = `Sign in to Antigravity and call its models.

Usage:
  node src/cli.js login [--no-browser] [--port 51121] [--out file] [--code value]
  node src/cli.js refresh [--out file]
  node src/cli.js status [--out file]
  node src/cli.js models [--out file] [--json] [--endpoint-mode auto|production|sandbox]
  node src/cli.js generate [--model id] [--effort off|minimal|low|medium|high] [--prompt text]
                         [--system text] [--max-tokens n] [--temperature n]
                         [--endpoint-mode auto|production|sandbox] [--show-thinking] [--json]
                         [--new-session] [--messages file] [--tools file]
  node src/cli.js serve [--host 127.0.0.1] [--port 8787] [--api-key value]
                        [--api-key-file file] [--endpoint-mode auto|production|sandbox]

login opens the browser and listens on http://127.0.0.1:51121/oauth-callback.
On Windows the browser is opened with PowerShell. On Linux it uses xdg-open
(wslview under WSL). You can also paste the redirect URL if the callback cannot
reach this machine.

models lists the logical models for the signed-in account. generate sends the
prompt to the selected model. The default model is ${DEFAULT_MODEL_ID}.
--effort selects the thinking tier and the upstream wire id.

serve listens for POST /v1/chat/completions. Every call uses ${SERVER_MODEL_ID}.
effort defaults to ${DEFAULT_SERVER_EFFORT}. Send the API key as
Authorization: Bearer <key>, x-api-key, or JSON apiKey. Prompts, messages,
and tools are forwarded. The key is --api-key, else ANTIGRAVITY_API_KEY, else
~/.antigravity-provider/api-key (created on first start).

Credentials are saved to ~/.antigravity-provider/credentials.json
The conversation envelope is saved next to that file as session.json.
Tokens are never printed.
`;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	/** @type {Record<string, any>} */
	const args = {
		command: "login",
		browser: true,
		help: false,
		json: false,
		showThinking: false,
		newSession: false,
		positionals: [],
	};
	const rest = argv.slice(2);
	if (rest[0] && !rest[0].startsWith("-")) args.command = rest.shift() ?? "login";
	const take = (flag, index) => {
		const value = rest[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		return value;
	};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		if (flag === "--no-browser") args.browser = false;
		else if (flag === "--help" || flag === "-h") args.help = true;
		else if (flag === "--json") args.json = true;
		else if (flag === "--show-thinking") args.showThinking = true;
		else if (flag === "--new-session") args.newSession = true;
		else if (flag === "--port") args.port = Number(take(flag, i++));
		else if (flag === "--out") args.out = take(flag, i++);
		else if (flag === "--code") args.code = take(flag, i++);
		else if (flag === "--model") args.model = take(flag, i++);
		else if (flag === "--effort") args.effort = take(flag, i++);
		else if (flag === "--prompt") args.prompt = take(flag, i++);
		else if (flag === "--system") args.system = take(flag, i++);
		else if (flag === "--max-tokens") args.maxTokens = Number(take(flag, i++));
		else if (flag === "--temperature") args.temperature = Number(take(flag, i++));
		else if (flag === "--endpoint-mode") args.endpointMode = take(flag, i++);
		else if (flag === "--endpoint") args.endpoint = take(flag, i++);
		else if (flag === "--messages") args.messages = take(flag, i++);
		else if (flag === "--tools") args.tools = take(flag, i++);
		else if (flag === "--host") args.host = take(flag, i++);
		else if (flag === "--api-key") args.apiKey = take(flag, i++);
		else if (flag === "--api-key-file") args.apiKeyFile = take(flag, i++);
		else if (flag.startsWith("-")) throw new Error(`Unknown argument: ${flag}`);
		else args.positionals.push(flag);
	}
	if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)) {
		throw new Error(`Invalid --port: ${args.port}`);
	}
	if (args.maxTokens !== undefined && (!Number.isFinite(args.maxTokens) || args.maxTokens <= 0)) {
		throw new Error(`Invalid --max-tokens: ${args.maxTokens}`);
	}
	if (args.temperature !== undefined && !Number.isFinite(args.temperature)) {
		throw new Error(`Invalid --temperature: ${args.temperature}`);
	}
	if (args.endpointMode !== undefined && !["auto", "production", "sandbox"].includes(args.endpointMode)) {
		throw new Error(`Invalid --endpoint-mode: ${args.endpointMode}`);
	}
	const efforts = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	if (args.effort !== undefined && !efforts.has(args.effort)) throw new Error(`Invalid --effort: ${args.effort}`);
	if (args.command !== "generate" && args.positionals.length > 0) {
		throw new Error(`Unknown argument: ${args.positionals[0]}`);
	}
	return args;
}

/**
 * @param {AbortSignal} signal
 */
function promptForCode(signal) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (fn) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			rl.close();
			fn();
		};
		const onAbort = () => {
			finish(() => reject(Object.assign(new Error("Login cancelled"), { name: "AbortError" })));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		rl.question("Paste the authorization code (or full redirect URL): ", (answer) => {
			finish(() => resolve(answer));
		});
	});
}

/**
 * @param {{ email?: string, projectId?: string, expires?: number }} credential
 * @param {string} file
 */
function printIdentity(credential, file) {
	const who = credential.email ? ` as ${credential.email}` : "";
	process.stdout.write(`Logged in to Antigravity${who}\n`);
	if (credential.projectId) process.stdout.write(`Project: ${credential.projectId}\n`);
	if (credential.expires) process.stdout.write(`Access token refreshes after: ${new Date(credential.expires).toISOString()}\n`);
	process.stdout.write(`Credentials saved to ${file}\n`);
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.help || args.command === "help") {
		process.stdout.write(HELP);
		return;
	}
	const file = args.out ?? defaultCredentialPath();

	if (args.command === "status") {
		let credential;
		try {
			credential = loadCredentials(file);
		} catch (error) {
			const code = /** @type {NodeJS.ErrnoException} */ (error).code;
			if (code === "ENOENT") {
				process.stdout.write(`Not logged in. Credential file not found: ${file}\n`);
				process.exitCode = 1;
				return;
			}
			throw error;
		}
		const when = credential.expires ? new Date(credential.expires).toISOString() : "unknown";
		process.stdout.write(`Account: ${credential.email ?? "unknown"}\n`);
		process.stdout.write(`Project: ${credential.projectId ?? "missing"}\n`);
		process.stdout.write(`Access token refresh due: ${when}\n`);
		process.stdout.write(`Credentials: ${file}\n`);
		return;
	}

	if (args.command === "serve") {
		readStored(file);
		const apiKey = resolveServerApiKey({
			key: args.apiKey,
			env: process.env.ANTIGRAVITY_API_KEY,
			file: args.apiKeyFile ?? defaultApiKeyPath(),
		});
		const host = args.host ?? "127.0.0.1";
		const port = args.port ?? 8787;
		const server = createChatServer({
			apiKey: apiKey.key,
			credentialPath: file,
			loadCredential: () => loadCredentials(file),
			endpoint: args.endpoint,
			endpointMode: args.endpointMode,
		});
		const address = await listen(server, { host, port });
		const shownHost = host.includes(":") ? `[${host}]` : host;
		process.stdout.write(`Antigravity server listening on http://${shownHost}:${address.port}\n`);
		process.stdout.write(`Model: ${SERVER_MODEL_ID}\n`);
		process.stdout.write(`Default effort: ${DEFAULT_SERVER_EFFORT}\n`);
		process.stdout.write("POST /v1/chat/completions\n");
		if (apiKey.created) process.stdout.write(`API key (saved to ${apiKey.path}): ${apiKey.key}\n`);
		else if (apiKey.source === "file") process.stdout.write(`API key file: ${apiKey.path}\n`);
		else if (apiKey.source === "env") process.stdout.write("API key from ANTIGRAVITY_API_KEY\n");
		else process.stdout.write("API key from --api-key\n");
		const stop = () => {
			server.close(() => process.exit(0));
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		return;
	}

	if (args.command === "refresh") {
		const stored = loadCredentials(file);
		const credential = await refreshAntigravity(stored);
		saveCredentials({ ...stored, ...credential }, file);
		printIdentity(credential, file);
		return;
	}

	if (args.command === "models") {
		const stored = readStored(file);
		const listed = await listAntigravityModels({
			credential: stored,
			credentialPath: file,
			endpoint: discoveryEndpoint(args),
		});
		printModels(listed, args.json);
		return;
	}

	if (args.command === "generate") {
		const stored = readStored(file);
		const prompt = args.prompt ?? (args.positionals.length > 0 ? args.positionals.join(" ") : await promptFromStdin());
		const messageFile = args.messages ? readJsonFile(args.messages) : undefined;
		const toolFile = args.tools ? readJsonFile(args.tools) : undefined;
		const result = await generateAntigravity({
			credential: stored,
			credentialPath: file,
			sessionPath: sessionPathFor(file),
			newSession: args.newSession,
			model: args.model,
			effort: args.effort,
			prompt,
			messages: Array.isArray(messageFile) ? messageFile : messageFile?.messages,
			systemPrompt: args.system ?? (Array.isArray(messageFile) ? undefined : messageFile?.systemPrompt),
			tools: Array.isArray(toolFile) ? toolFile : toolFile?.tools,
			toolChoice: Array.isArray(toolFile) ? undefined : toolFile?.toolChoice,
			maxTokens: args.maxTokens,
			temperature: args.temperature,
			endpoint: args.endpoint,
			endpointMode: args.endpointMode,
			onText(delta) {
				if (!args.json) process.stdout.write(delta);
			},
			onThinking(delta) {
				if (args.showThinking && !args.json) process.stderr.write(delta);
			},
		});
		if (args.json) {
			process.stdout.write(
				`${JSON.stringify(
					{
						model: result.model,
						wireModelId: result.wireModelId,
						effort: result.effort ?? "off",
						stopReason: result.stopReason,
						text: result.text,
						thinking: result.thinking,
						toolCalls: result.toolCalls,
						usage: result.usage,
						endpoint: result.endpoint,
					},
					null,
					2,
				)}\n`,
			);
			return;
		}
		if (result.text && !result.text.endsWith("\n")) process.stdout.write("\n");
		for (const call of result.toolCalls) {
			process.stdout.write(`${JSON.stringify({ tool: call.name, id: call.id, arguments: call.arguments })}\n`);
		}
		return;
	}

	if (args.command !== "login") {
		throw new Error(`Unknown command: ${args.command}\n\n${HELP}`);
	}

	const abort = new AbortController();
	const onSigint = () => abort.abort("SIGINT");
	process.once("SIGINT", onSigint);

	const interactive = Boolean(process.stdin.isTTY) && args.code === undefined;
	/** @type {((signal: AbortSignal) => Promise<string>) | undefined} */
	let readManualCode;
	if (args.code !== undefined) {
		let used = false;
		readManualCode = async () => {
			if (used) throw new Error("The authorization code from --code was not accepted.");
			used = true;
			return args.code ?? "";
		};
	} else if (interactive) {
		readManualCode = (signal) => promptForCode(signal);
	}

	const credential = await loginAntigravity({
		openBrowser: args.browser,
		port: args.port,
		credentialPath: file,
		signal: abort.signal,
		onProgress(message) {
			process.stdout.write(`${message}\n`);
		},
		onAuth({ url, launchUrl, instructions }) {
			process.stdout.write("\nOpen this URL in your browser:\n");
			process.stdout.write(`${url}\n`);
			if (launchUrl && launchUrl !== url) {
				process.stdout.write(`Local shortcut (this machine only): ${launchUrl}\n`);
			}
			if (instructions) process.stdout.write(`${instructions}\n\n`);
		},
		readManualCode,
	});
	process.stdout.write("\n");
	printIdentity(credential, credential.credentialPath ?? file);
}

/**
 * Discovery pins one host when the caller asks for production or sandbox.
 * Auto tries daily, then sandbox.
 * @param {{ endpoint?: string, endpointMode?: string }} args
 */
function discoveryEndpoint(args) {
	if (args.endpoint) return args.endpoint;
	if (args.endpointMode === "production") return ANTIGRAVITY_DAILY_ENDPOINT;
	if (args.endpointMode === "sandbox") return ANTIGRAVITY_SANDBOX_ENDPOINT;
	return undefined;
}

/**
 * @param {string} file
 */
function readStored(file) {
	try {
		return loadCredentials(file);
	} catch (error) {
		const code = /** @type {NodeJS.ErrnoException} */ (error).code;
		if (code === "ENOENT") throw new Error(`Not logged in. Credential file not found: ${file}`);
		throw error;
	}
}

/**
 * @param {string} file
 */
function readJsonFile(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function promptFromStdin() {
	if (process.stdin.isTTY) return Promise.resolve(undefined);
	return new Promise((resolve, reject) => {
		const chunks = [];
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim() || undefined));
		process.stdin.on("error", reject);
	});
}

/**
 * @param {{ models: object[], imageModel?: { id: string } | null, endpoint: string }} listed
 * @param {boolean} asJson
 */
function printModels(listed, asJson) {
	if (asJson) {
		process.stdout.write(
			`${JSON.stringify(
				{
					endpoint: listed.endpoint,
					defaultModel: listed.models.some((model) => model.id === DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : listed.models[0]?.id,
					imageModel: listed.imageModel?.id ?? null,
					models: listed.models.map(publicModel),
				},
				null,
				2,
			)}\n`,
		);
		return;
	}
	process.stdout.write(`Endpoint: ${listed.endpoint}\n`);
	if (listed.models.length === 0) process.stdout.write("No chat models returned.\n");
	for (const model of listed.models) {
		const marker = model.id === DEFAULT_MODEL_ID ? " (default)" : "";
		const efforts = effortSummary(model);
		const input = (model.input ?? ["text"]).join(", ");
		process.stdout.write(`${model.id}${marker}\n`);
		process.stdout.write(`  ${model.name}  input: ${input}  context: ${model.contextWindow}  max output: ${model.maxTokens}\n`);
		if (efforts) process.stdout.write(`  thinking: ${efforts}\n`);
	}
	if (listed.imageModel?.id) process.stdout.write(`Image model: ${listed.imageModel.id}\n`);
}

/**
 * @param {object} model
 */
function publicModel(model) {
	return {
		id: model.id,
		name: model.name,
		aliases: model.aliases,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		requestModelId: model.requestModelId,
		thinking: model.thinking,
		kind: model.kind,
	};
}

/**
 * @param {object} model
 */
function effortSummary(model) {
	const routing = model.thinking?.effortRouting;
	if (!routing) {
		const efforts = model.thinking?.efforts;
		return efforts?.length ? efforts.join(", ") : "";
	}
	return Object.entries(routing)
		.map(([effort, wire]) => `${effort} → ${wire}`)
		.join("; ");
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	const command = process.argv[2];
	const label = !command || command === "login" || command === "refresh" || command.startsWith("-") ? "Login failed" : "Error";
	process.stderr.write(`${label}: ${message}\n`);
	process.exitCode = 1;
});
