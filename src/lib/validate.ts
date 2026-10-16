// Input validation shared by routes and tests.

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
// C0 controls, DEL, and C1 controls; browsers strip or reinterpret these inside URLs.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RWSTRIPE_PARAMS = ["rwstripe_checkout", "rwstripe_login"];

export const MAX_RETURN_PATH_LENGTH = 2048;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim + lowercase; null when the value is not a plausible address. */
export function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	if (email.length < 3 || email.length > 254) return null;
	return EMAIL_PATTERN.test(email) ? email : null;
}

/** The address as typed (trimmed) and lowercased, for Stripe's case-sensitive email filter. */
export function emailLookupVariants(value: unknown): string[] {
	const normalized = normalizeEmail(value);
	if (!normalized || typeof value !== "string") return [];
	return [...new Set([normalized, value.trim()])];
}

export function isShortString(value: unknown, max = 200): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * The site's public origin from `ctx.site.url`, or null when it is missing or not
 * an absolute http(s) URL. Plain http is accepted only for loopback hosts, matching
 * core's rule for links that carry sign-in tokens.
 */
export function siteOriginFrom(siteUrl: unknown): string | null {
	if (typeof siteUrl !== "string" || !siteUrl) return null;
	let url: URL;
	try {
		url = new URL(siteUrl);
	} catch {
		return null;
	}
	if (url.protocol === "https:") return url.origin;
	if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
	return null;
}

/**
 * Validate a same-site relative return path and return its normalized
 * `pathname + search` (fragment and rwstripe_* params removed), or null.
 */
export function validateReturnPath(value: unknown, siteOrigin: string): string | null {
	if (typeof value !== "string") return null;
	if (value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return null;
	if (!value.startsWith("/") || value.startsWith("//")) return null;
	if (value.includes("\\") || CONTROL_CHARS.test(value)) return null;

	let url: URL;
	try {
		url = new URL(value, siteOrigin);
	} catch {
		return null;
	}
	if (url.origin !== siteOrigin) return null;
	// Re-check after normalization (dot segments, percent-decoding of the path).
	if (url.pathname.startsWith("//")) return null;

	for (const param of RWSTRIPE_PARAMS) url.searchParams.delete(param);
	return `${url.pathname}${url.search}`;
}

/** Append a query parameter to an absolute URL string, keeping `value` verbatim. */
export function appendRawParam(url: string, name: string, value: string): string {
	return `${url}${url.includes("?") ? "&" : "?"}${name}=${value}`;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const STRIPE_ID_PATTERNS = {
	price: /^price_[A-Za-z0-9]{1,250}$/,
	product: /^prod_[A-Za-z0-9]{1,250}$/,
	checkoutSession: /^cs_(test|live)_[A-Za-z0-9]{1,250}$/,
	account: /^acct_[A-Za-z0-9]{1,250}$/,
} as const;

export function isStripeId(kind: keyof typeof STRIPE_ID_PATTERNS, value: unknown): value is string {
	return typeof value === "string" && STRIPE_ID_PATTERNS[kind].test(value);
}
