// WebCrypto helpers: random tokens and SHA-256 storage keys.

const TOKEN_BYTES = 32;
// 32 bytes encode to 43 base64url characters without padding.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export function isTokenShape(value: unknown): value is string {
	return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}
