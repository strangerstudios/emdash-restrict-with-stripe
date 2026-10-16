// Stripe credentials and display settings.
//
// The secret key lives in ctx.settings under a `secret` schema field, so EmDash
// encrypts it with EMDASH_ENCRYPTION_KEY before it reaches the database. Non-secret
// connection details live in KV. The KV record carries sha256(secretKey) so a key
// replaced through the generated settings form is never paired with stale
// Connect details.

import { type Ctx, fail, requireHttp } from "./context.js";
import { sha256Hex } from "./crypto.js";
import { StripeClient } from "./stripe.js";

export const SECRET_KEY_SETTING = "stripeSecretKey";
export const SHOW_EXCERPTS_SETTING = "showExcerpts";
const CONNECTION_STATE_KEY = "state:stripe-connection";

export type StripeEnvironment = "live" | "sandbox";
export type KeySource = "connect" | "manual";

export interface ConnectionState {
	keyHash: string;
	keySource: KeySource;
	environment: StripeEnvironment;
	accountId: string | null;
	publishableKey: string | null;
	connectHashed: boolean;
	savedAt: string;
}

export interface StripeConfig {
	secretKey: string;
	keyHash: string;
	keySource: KeySource;
	environment: StripeEnvironment;
	accountId: string | null;
	publishableKey: string | null;
	connectHashed: boolean;
}

const KEY_PATTERN = /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}$/;

export function isStripeSecretKey(value: unknown): value is string {
	return typeof value === "string" && KEY_PATTERN.test(value);
}

export function keyEnvironment(key: string): StripeEnvironment {
	return /^(sk|rk)_test_/.test(key) ? "sandbox" : "live";
}

function isEncryptionKeyError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && code.startsWith("PLUGIN_SETTING_");
}

/** The decrypted secret key, or null when unset. Throws a route error if it cannot be decrypted. */
export async function readSecretKey(ctx: Ctx): Promise<string | null> {
	try {
		const key = await ctx.settings.get<string>(SECRET_KEY_SETTING);
		return typeof key === "string" && key ? key : null;
	} catch (error) {
		if (isEncryptionKeyError(error)) {
			fail(
				"ENCRYPTION_KEY_UNAVAILABLE",
				"The stored Stripe key cannot be decrypted. Check EMDASH_ENCRYPTION_KEY.",
				503,
			);
		}
		throw error;
	}
}

export async function getStripeConfig(ctx: Ctx): Promise<StripeConfig | null> {
	const secretKey = await readSecretKey(ctx);
	if (!secretKey) return null;
	const keyHash = await sha256Hex(secretKey);
	const state = await ctx.kv.get<ConnectionState>(CONNECTION_STATE_KEY);
	const matches = state?.keyHash === keyHash;
	return {
		secretKey,
		keyHash,
		keySource: matches ? state.keySource : "manual",
		environment: keyEnvironment(secretKey),
		accountId: matches ? state.accountId : null,
		publishableKey: matches ? state.publishableKey : null,
		connectHashed: matches ? state.connectHashed : false,
	};
}

/** Like getStripeConfig, but fails the route when Stripe is not set up. */
export async function requireStripe(ctx: Ctx): Promise<{ config: StripeConfig; stripe: StripeClient }> {
	const config = await getStripeConfig(ctx);
	if (!config) fail("STRIPE_NOT_CONFIGURED", "Stripe is not connected for this site.", 503);
	return { config, stripe: new StripeClient(config.secretKey, requireHttp(ctx).fetch) };
}

/** Store a secret key and its connection details. Refuses when the key cannot be encrypted. */
export async function saveStripeKey(
	ctx: Ctx,
	details: Omit<ConnectionState, "keyHash" | "savedAt"> & { secretKey: string },
): Promise<void> {
	try {
		await ctx.settings.set(SECRET_KEY_SETTING, details.secretKey);
	} catch (error) {
		if (isEncryptionKeyError(error)) {
			fail(
				"ENCRYPTION_KEY_UNAVAILABLE",
				"EMDASH_ENCRYPTION_KEY must be set before a Stripe key can be stored.",
				503,
			);
		}
		throw error;
	}
	const state: ConnectionState = {
		keyHash: await sha256Hex(details.secretKey),
		keySource: details.keySource,
		environment: details.environment,
		accountId: details.accountId,
		publishableKey: details.publishableKey,
		connectHashed: details.connectHashed,
		savedAt: new Date().toISOString(),
	};
	await ctx.kv.set(CONNECTION_STATE_KEY, state);
	await ctx.kv.delete(PERMISSION_ERROR_KEY);
	await ctx.kv.delete(PERMISSION_REPORT_KEY);
}

export async function clearStripeKey(ctx: Ctx): Promise<void> {
	await ctx.settings.delete(SECRET_KEY_SETTING);
	await ctx.kv.delete(CONNECTION_STATE_KEY);
	await ctx.kv.delete(PRODUCTS_CACHE_KEY);
	await ctx.kv.delete(PORTAL_CONFIG_KEY);
	await ctx.kv.delete(PERMISSION_ERROR_KEY);
	await ctx.kv.delete(PERMISSION_REPORT_KEY);
}

export async function getShowExcerpts(ctx: Ctx): Promise<boolean> {
	return (await ctx.settings.get<boolean>(SHOW_EXCERPTS_SETTING)) ?? true;
}

export const PRODUCTS_CACHE_KEY = "cache:products";
export const PORTAL_CONFIG_KEY = "cache:portal-configuration";
export const PERMISSION_ERROR_KEY = "state:last-permission-error";
export const PERMISSION_REPORT_KEY = "state:permission-report";

/** Masked description of the stored key; never includes the key itself. */
export function describeKey(key: string): { type: "secret" | "restricted"; last4: string } {
	return { type: key.startsWith("rk_") ? "restricted" : "secret", last4: key.slice(-4) };
}
