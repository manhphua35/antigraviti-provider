/**
 * User-Agent captured from the Antigravity hub client. The Cloud Code Assist
 * backend gates newer models on this version. os/arch stay pinned to the
 * darwin/arm64 reference client unless overridden; the login machine's own
 * platform is not what the backend checks.
 */

export const DEFAULT_ANTIGRAVITY_VERSION = "2.8.0";

const ANTIGRAVITY_VERSION_MANIFEST_URL =
	"https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;

let discoveredAntigravityVersion = null;
let antigravityVersionFetch = null;

export function getAntigravityVersion() {
	return process.env.PI_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion || DEFAULT_ANTIGRAVITY_VERSION;
}

/** @param {string} yamlText */
export function parseAntigravityManifestVersion(yamlText) {
	for (const line of yamlText.split(/\r?\n/)) {
		const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
		if (!match) continue;
		const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
	}
	return null;
}

/**
 * Resolve the latest hub version. Failures stay silent and keep the pinned fallback.
 * @param {typeof fetch} [fetcher]
 * @param {AbortSignal} [signal]
 */
export function ensureAntigravityVersion(fetcher = fetch, signal) {
	if (process.env.PI_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion) return Promise.resolve();
	if (antigravityVersionFetch) return antigravityVersionFetch;

	antigravityVersionFetch = (async () => {
		try {
			const timeoutSignal = AbortSignal.timeout(ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS);
			const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
				headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
				signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			});
			if (response.ok) {
				discoveredAntigravityVersion = parseAntigravityManifestVersion(await response.text());
			}
		} catch {
			// The pinned fallback remains valid when version discovery fails.
		} finally {
			if (!discoveredAntigravityVersion) antigravityVersionFetch = null;
		}
	})();
	return antigravityVersionFetch;
}

export function getAntigravityUserAgent() {
	const version = getAntigravityVersion();
	const cl = process.env.PI_AI_ANTIGRAVITY_CL || "963137146";
	const os = process.env.PI_AI_ANTIGRAVITY_OS || "darwin";
	const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || "arm64";
	return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}
