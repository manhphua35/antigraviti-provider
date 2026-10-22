import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "launcher");
const payloadDir = path.join(launcher, "payload");
const cacheDir = path.join(payloadDir, "cache");
const distDir = path.join(root, "dist");
const full = process.argv.includes("--full");
const outputExe = path.join(distDir, full ? "antigravity-provider-full.exe" : "antigravity-provider.exe");

if (process.platform !== "win32") {
	throw new Error("The tray launcher is Windows-only. Run this build on Windows.");
}

const nodeExe = process.env.NODE_EXE ?? process.execPath;

function entry(name, data) {
	const nameBytes = Buffer.from(name, "utf8");
	const head = Buffer.alloc(2);
	head.writeUInt16LE(nameBytes.length);
	const size = Buffer.alloc(8);
	size.writeBigUInt64LE(BigInt(data.length));
	return Buffer.concat([head, nameBytes, size, data]);
}

function compress(data) {
	return zlib.brotliCompressSync(data, {
		params: {
			[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
			[zlib.constants.BROTLI_PARAM_LGWIN]: 24,
			[zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
		},
	});
}

function walk(dir) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((item) => {
			const full = path.join(dir, item.name);
			return item.isDirectory() ? walk(full) : [full];
		})
		.sort();
}

function nodeSection() {
	const data = fs.readFileSync(nodeExe);
	const key = crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
	const cached = path.join(cacheDir, `node-${key}.br`);
	if (fs.existsSync(cached)) {
		console.log(`Using cached Node payload (${key})`);
		return fs.readFileSync(cached);
	}
	console.log(`Compressing Node ${process.version} (${(data.length / 1048576).toFixed(1)} MB). This takes a few minutes the first time...`);
	const packed = compress(entry("node/node.exe", data));
	fs.mkdirSync(cacheDir, { recursive: true });
	for (const old of fs.readdirSync(cacheDir)) fs.rmSync(path.join(cacheDir, old));
	fs.writeFileSync(cached, packed);
	return packed;
}

function appSection() {
	const entries = [entry("app/package.json", fs.readFileSync(path.join(root, "package.json")))];
	const srcDir = path.join(root, "src");
	for (const file of walk(srcDir)) {
		const name = `app/src/${path.relative(srcDir, file).split(path.sep).join("/")}`;
		entries.push(entry(name, fs.readFileSync(file)));
	}
	return compress(Buffer.concat(entries));
}

function lengthPrefixed(buffer) {
	const head = Buffer.alloc(8);
	head.writeBigUInt64LE(BigInt(buffer.length));
	return Buffer.concat([head, buffer]);
}

fs.mkdirSync(payloadDir, { recursive: true });
const sections = full ? [nodeSection(), appSection()] : [appSection()];
const payload = Buffer.concat(sections.map(lengthPrefixed));
fs.writeFileSync(path.join(payloadDir, "payload.br"), payload);
console.log(`Payload: ${(payload.length / 1048576).toFixed(1)} MB`);

const cargo = spawnSync("cargo", ["build", "--release"], { cwd: launcher, stdio: "inherit" });
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(path.join(launcher, "target", "release", "antigravity-tray.exe"), outputExe);
console.log(`Built ${outputExe} (${(fs.statSync(outputExe).size / 1048576).toFixed(1)} MB)`);
