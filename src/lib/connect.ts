// Stripe Connect through connect.restrictwithstripe.com.
//
// The connect server appends its results to our return_url, so the return URL
// carries a single-use state value issued by the plugin. A forged
// "?pmpro_stripe_connected=true&pmpro_stripe_access_token=..." link therefore
// cannot swap in someone else's Stripe account, and a forged disconnect link
// cannot clear the keys.

import { type Ctx, PLUGIN_ID } from "./context.js";
import { randomToken, sha256Hex } from "./crypto.js";
import type { StripeEnvironment } from "./config.js";
import { isStripeId } from "./validate.js";

export const CONNECT_SERVER = "https://connect.restrictwithstripe.com";
export const SETTINGS_PAGE_PATH = `/_emdash/admin/plugins/${PLUGIN_ID}/settings`;
export const STATE_PARAM = "rwstripe_state";

const STATE_PREFIX = "state:connect-flow:";
const STATE_TTL_MS = 60 * 60 * 1000;

export type FlowKind = "connect" | "disconnect";

interface FlowState {
	kind: FlowKind;
	environment: StripeEnvironment;
	userId: string | null;
	expiresAt: number;
}

export function settingsReturnUrl(siteOrigin: string, state: string): string {
	return `${siteOrigin}${SETTINGS_PAGE_PATH}?${STATE_PARAM}=${encodeURIComponent(state)}`;
}

export function buildAuthorizeUrl(options: {
	environment: StripeEnvironment;
	siteName: string;
	returnUrl: string;
}): string {
	const params = new URLSearchParams({
		action: "authorize",
		gateway_environment: options.environment,
		site_name: options.siteName,
		supports_hash: "1",
		return_url: options.returnUrl,
	});
	return `${CONNECT_SERVER}/?${params.toString()}`;
}

export function buildDisconnectUrl(options: {
	environment: StripeEnvironment;
	accountId: string;
	keyHash: string;
	returnUrl: string;
}): string {
	const params = new URLSearchParams({
		action: "disconnect",
		gateway_environment: options.environment,
		stripe_user_id: options.accountId,
		key_hash: options.keyHash,
		return_url: options.returnUrl,
	});
	return `${CONNECT_SERVER}/?${params.toString()}`;
}

export async function issueFlowState(
	ctx: Ctx,
	kind: FlowKind,
	environment: StripeEnvironment,
	userId: string | null,
	now = Date.now(),
): Promise<string> {
	await purgeExpiredFlowStates(ctx, now);
	const state = randomToken();
	const record: FlowState = { kind, environment, userId, expiresAt: now + STATE_TTL_MS };
	await ctx.kv.set(`${STATE_PREFIX}${await sha256Hex(state)}`, record);
	return state;
}

/** Single-use: the state is deleted whether or not it matches. Bound to the admin who started the flow. */
export async function consumeFlowState(
	ctx: Ctx,
	state: unknown,
	kind: FlowKind,
	userId: string | null,
	now = Date.now(),
): Promise<FlowState | null> {
	if (typeof state !== "string" || state.length === 0 || state.length > 128) return null;
	const key = `${STATE_PREFIX}${await sha256Hex(state)}`;
	const current = await ctx.kv.getVersioned<FlowState>(key);
	if (!current) return null;
	const { applied } = await ctx.kv.compareAndDelete(key, current.revision);
	if (!applied) return null;
	if (current.value.kind !== kind || current.value.expiresAt <= now) return null;
	if (current.value.userId !== userId) return null;
	return current.value;
}

async function purgeExpiredFlowStates(ctx: Ctx, now: number): Promise<void> {
	for (const entry of await ctx.kv.list(STATE_PREFIX)) {
		const value = entry.value as Partial<FlowState> | null;
		if (!value || typeof value.expiresAt !== "number" || value.expiresAt <= now) {
			await ctx.kv.delete(entry.key);
		}
	}
}

export type ConnectReturn =
	| {
			ok: true;
			accessToken: string;
			publishableKey: string | null;
			accountId: string;
			environment: StripeEnvironment;
			hashed: boolean;
	  }
	| { ok: false; message: string };

const ACCESS_TOKEN_PATTERN = /^sk_(live|test)_[A-Za-z0-9]{8,}$/;
const PUBLISHABLE_KEY_PATTERN = /^pk_(live|test)_[A-Za-z0-9]{8,}$/;

function environmentParam(value: unknown): StripeEnvironment | null {
	return value === "live" || value === "sandbox" ? value : null;
}

/** Validate the parameters the connect server appended after an authorize flow. */
export function parseConnectReturn(
	params: Record<string, unknown>,
	expectedEnvironment: StripeEnvironment,
): ConnectReturn {
	if (params.pmpro_stripe_connected !== "true") {
		const message =
			typeof params.error_message === "string" && params.error_message
				? params.error_message
				: "Stripe connection was not completed.";
		return { ok: false, message };
	}
	const environment = environmentParam(params.pmpro_stripe_connected_environment);
	if (environment !== expectedEnvironment) {
		return { ok: false, message: "Stripe returned a different environment than requested." };
	}
	const accessToken = params.pmpro_stripe_access_token;
	if (typeof accessToken !== "string" || !ACCESS_TOKEN_PATTERN.test(accessToken)) {
		return { ok: false, message: "Stripe did not return a valid access token." };
	}
	if ((environment === "sandbox") !== accessToken.startsWith("sk_test_")) {
		return { ok: false, message: "The access token does not match the requested environment." };
	}
	const accountId = params.pmpro_stripe_user_id;
	if (!isStripeId("account", accountId)) {
		return { ok: false, message: "Stripe did not return a valid account ID." };
	}
	const publishable = params.pmpro_stripe_publishable_key;
	return {
		ok: true,
		accessToken,
		accountId,
		environment,
		publishableKey:
			typeof publishable === "string" && PUBLISHABLE_KEY_PATTERN.test(publishable) ? publishable : null,
		hashed: params.pmpro_stripe_connect_hashed === "true",
	};
}

export type DisconnectReturn =
	| { action: "clear" }
	| { action: "keep"; message: string; cancelled: boolean };

/**
 * Keys are cleared only when the server reports success for the account this site
 * is connected to. Anything else, including a cancel, keeps them.
 */
export function parseDisconnectReturn(
	params: Record<string, unknown>,
	connectedAccountId: string | null,
): DisconnectReturn {
	if (params.pmpro_stripe_disconnected !== "true") {
		const cancelled = params.error_code === "cancelled";
		const message =
			typeof params.error_message === "string" && params.error_message
				? params.error_message
				: cancelled
					? "Stripe disconnect was cancelled."
					: "Stripe disconnect did not complete.";
		return { action: "keep", message, cancelled };
	}
	if (!connectedAccountId || params.stripe_user_id !== connectedAccountId) {
		return {
			action: "keep",
			message: "The disconnected account does not match this site's Stripe account. Keys were kept.",
			cancelled: false,
		};
	}
	return { action: "clear" };
}
