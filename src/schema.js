/**
 * Project a tool JSON Schema onto the legacy `parameters` object Cloud Code
 * Assist accepts. Exotic combinators fall back to an empty object schema, the
 * same stand-in oh-my-pi uses when a schema still cannot be represented.
 */

const FALLBACK_SCHEMA = Object.freeze({ type: "object", properties: {} });

/** Fields the Google / Cloud Code Assist proto rejects. */
const UNSUPPORTED = new Set([
	"$schema",
	"$ref",
	"$defs",
	"$dynamicRef",
	"$dynamicAnchor",
	"examples",
	"prefixItems",
	"unevaluatedProperties",
	"unevaluatedItems",
	"patternProperties",
	"additionalProperties",
	"propertyNames",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"pattern",
	"format",
	"dependencies",
	"dependentSchemas",
	"dependentRequired",
	"x-mcp-header",
	"deprecated",
	"readOnly",
	"writeOnly",
	"$comment",
]);

const LIFTABLE = new Set([
	"pattern",
	"format",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasResidualIncompatibility(value) {
	if (Array.isArray(value)) return value.some((entry) => hasResidualIncompatibility(entry));
	if (!value || typeof value !== "object") return false;
	const record = /** @type {Record<string, unknown>} */ (value);
	if (Array.isArray(record.type) || record.type === "null") return true;
	if ("nullable" in record || "anyOf" in record || "oneOf" in record || "allOf" in record || "not" in record) {
		return true;
	}
	return Object.values(record).some((entry) => entry && typeof entry === "object" && hasResidualIncompatibility(entry));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function spillValue(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function project(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...FALLBACK_SCHEMA };
	/** @type {Record<string, unknown>} */
	const out = {};
	/** @type {string[]} */
	const spilled = [];
	for (const [key, entry] of Object.entries(value)) {
		if (UNSUPPORTED.has(key)) {
			if (LIFTABLE.has(key)) spilled.push(`${key}: ${spillValue(entry)}`);
			continue;
		}
		if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
			/** @type {Record<string, unknown>} */
			const properties = {};
			for (const [name, schema] of Object.entries(entry)) properties[name] = project(schema);
			out.properties = properties;
			continue;
		}
		if ((key === "items" || key === "additionalItems") && entry && typeof entry === "object") {
			out[key] = project(entry);
			continue;
		}
		out[key] = entry;
	}
	if (out.type === "object" && out.properties === undefined) out.properties = {};
	if (spilled.length > 0) {
		const extra = spilled.join("; ");
		out.description = typeof out.description === "string" && out.description ? `${out.description} (${extra})` : extra;
	}
	return out;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function normalizeSchemaForCca(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...FALLBACK_SCHEMA };
	if (hasResidualIncompatibility(value)) return { ...FALLBACK_SCHEMA };
	return project(value);
}
