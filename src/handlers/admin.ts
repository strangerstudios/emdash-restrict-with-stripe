// Private admin routes (default plugins:manage permission). All are POST + JSON with
// an `action` field so the admin UI can call them through apiFetch().

import {
	clearStripeKey,
	describeKey,
	getShowExcerpts,
	getStripeConfig,
	isStripeSecretKey,
	keyEnvironment,
	type KeySource,
	PERMISSION_REPORT_KEY,
	requireStripe,
	saveStripeKey,
	SHOW_EXCERPTS_SETTING,
} from "../lib/config.js";
import {
	buildAuthorizeUrl,
	buildDisconnectUrl,
	consumeFlowState,
	issueFlowState,
	parseConnectReturn,
	parseDisconnectReturn,
	settingsReturnUrl,
	STATE_PARAM,
} from "../lib/connect.js";
import { type Ctx, fail, type RCtx, requireHttp, requireSiteOrigin, store } from "../lib/context.js";
import {
	checkKeyPermissions,
	clearPermissionError,
	lastPermissionError,
	type PermissionReport,
} from "../lib/permissions.js";
import { getActiveProducts } from "../lib/products.js";
import { listRestrictions, type Restriction, restrictionKey } from "../lib/restrictions.js";
import { StripeApiError, StripeClient } from "../lib/stripe.js";
import { isRecord, isShortString, isStripeId, siteOriginFrom } from "../lib/validate.js";
import { body, stripeCall } from "./util.js";

const ENTRY_PART = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PRODUCTS_PER_RESTRICTION = 50;
const MAX_TITLE_LOOKUPS = 200;

function actionOf(input: Record<string, unknown>, fallback: string): string {
	return typeof input.action === "string" ? input.action : fallback;
}

// ─── Settings ────────────────────────────────────────────────────

export async function describeSettings(ctx: Ctx) {
	let encryptionError = false;
	let config = null;
	try {
		config = await getStripeConfig(ctx);
	} catch {
		encryptionError = true;
	}
	const permissionError = config ? await lastPermissionError(ctx, config.keyHash) : null;
	const storedReport = config ? await ctx.kv.get<StoredReport>(PERMISSION_REPORT_KEY) : null;
	return {
		configured: config !== null,
		keySource: config?.keySource ?? null,
		environment: config?.environment ?? null,
		accountId: config?.accountId ?? null,
		key: config ? describeKey(config.secretKey) : null,
		publishableKeySet: Boolean(config?.publishableKey),
		connectHashed: config?.connectHashed ?? false,
		showExcerpts: await getShowExcerpts(ctx),
		siteUrl: siteOriginFrom(ctx.site.url),
		emailConfigured: Boolean(ctx.email),
		encryptionError,
		permissionError,
		permissionReport: storedReport && storedReport.keyHash === config?.keyHash ? storedReport.report : null,
	};
}

type StoredReport = { keyHash: string; report: PermissionReport };

/** Probe the stored key's permissions, remember the report, and clear a fixed runtime error. */
async function runPermissionCheck(ctx: Ctx): Promise<PermissionReport> {
	const { config, stripe } = await requireStripe(ctx);
	const report = await checkKeyPermissions(stripe, config.secretKey);
	await ctx.kv.set(PERMISSION_REPORT_KEY, { keyHash: config.keyHash, report } satisfies StoredReport);
	const recorded = await lastPermissionError(ctx, config.keyHash);
	if (recorded?.permission && report.results.some((r) => r.label === recorded.permission && r.status === "ok")) {
		await clearPermissionError(ctx);
	}
	return report;
}

export async function adminPermissionsHandler(ctx: RCtx) {
	const report = await runPermissionCheck(ctx);
	return { report, settings: await describeSettings(ctx) };
}

export async function adminSettingsHandler(ctx: RCtx) {
	const input = body(ctx);
	switch (actionOf(input, "get")) {
		case "get":
			return describeSettings(ctx);

		case "save": {
			if (input.showExcerpts !== undefined) {
				if (typeof input.showExcerpts !== "boolean") fail("INVALID_INPUT", "showExcerpts must be a boolean.");
				await ctx.settings.set(SHOW_EXCERPTS_SETTING, input.showExcerpts);
			}
			if (input.secretKey !== undefined) {
				const key = typeof input.secretKey === "string" ? input.secretKey.trim() : "";
				if (!isStripeSecretKey(key)) {
					fail("INVALID_KEY", "Enter a Stripe secret key (sk_...) or restricted key (rk_...).");
				}
				const account = await verifyKey(ctx, key);
				await saveStripeKey(ctx, {
					secretKey: key,
					keySource: "manual",
					environment: keyEnvironment(key),
					accountId: account,
					publishableKey: null,
					connectHashed: false,
				});
				if (key.startsWith("rk_")) {
					try {
						await runPermissionCheck(ctx);
					} catch (error) {
						ctx.log.warn("Permission check after saving a restricted key failed", { error: String(error) });
					}
				}
			}
			return describeSettings(ctx);
		}

		case "remove-key": {
			const config = await getStripeConfig(ctx);
			if (!config) return describeSettings(ctx);
			if (config.keySource === "connect" && input.confirmLocalOnly !== true) {
				fail(
					"USE_DISCONNECT",
					"This key came from Stripe Connect. Use Disconnect From Stripe, or confirm removing it locally.",
					409,
				);
			}
			await clearStripeKey(ctx);
			return describeSettings(ctx);
		}

		default:
			fail("UNKNOWN_ACTION", "Unknown settings action.");
	}
}

/** Confirm a key works and return its account ID (restricted keys may not read the account). */
async function verifyKey(ctx: Ctx, key: string): Promise<string | null> {
	const stripe = new StripeClient(key, requireHttp(ctx).fetch);
	try {
		return (await stripe.getAccount()).id;
	} catch (error) {
		if (error instanceof StripeApiError && error.isAuthError) {
			fail("INVALID_KEY", "Stripe rejected that key.");
		}
		if (error instanceof StripeApiError && error.status === 403 && key.startsWith("rk_")) {
			return null;
		}
		fail("STRIPE_ERROR", "Could not verify the key with Stripe. Try again.", 502);
	}
}

// ─── Key health ──────────────────────────────────────────────────

export type KeyHealth =
	| { configured: false; ok: false; needsReconnect: false; needsNewKey: false }
	| {
			configured: true;
			ok: boolean;
			needsReconnect: boolean;
			needsNewKey: boolean;
			keySource: KeySource;
			keyType: "secret" | "restricted";
			accountId?: string | null;
			error?: string;
			message?: string;
			permissionError?: string | null;
	  };

/** What admins see when Stripe rejects the stored key: reconnect for Connect, a new key otherwise. */
export function rejectedKeyHealth(keySource: KeySource, keyType: "secret" | "restricted"): KeyHealth {
	if (keySource === "connect") {
		return {
			configured: true,
			ok: false,
			needsReconnect: true,
			needsNewKey: false,
			keySource,
			keyType,
			message: "Stripe no longer accepts this site's Connect key. Reconnect to Stripe.",
		};
	}
	return {
		configured: true,
		ok: false,
		needsReconnect: false,
		needsNewKey: true,
		keySource,
		keyType,
		message:
			keyType === "restricted"
				? "Stripe rejected your restricted key (revoked, expired, or deleted). Update your restricted key."
				: "Stripe rejected your secret key (revoked or rolled). Update your secret key.",
	};
}

export async function adminKeyHealthHandler(ctx: RCtx): Promise<KeyHealth> {
	const config = await getStripeConfig(ctx);
	if (!config) return { configured: false, ok: false, needsReconnect: false, needsNewKey: false };
	const keyType = describeKey(config.secretKey).type;
	const permissionError = (await lastPermissionError(ctx, config.keyHash))?.message ?? null;
	const base = { configured: true as const, needsReconnect: false, needsNewKey: false, keySource: config.keySource, keyType, permissionError };
	const stripe = new StripeClient(config.secretKey, requireHttp(ctx).fetch);
	try {
		const account = await stripe.getAccount();
		return { ...base, ok: !permissionError, accountId: account.id };
	} catch (error) {
		if (error instanceof StripeApiError && error.isAuthError) {
			return rejectedKeyHealth(config.keySource, keyType);
		}
		if (error instanceof StripeApiError && error.status === 403) {
			// Restricted keys without account read access still work for everything else.
			return { ...base, ok: !permissionError, accountId: config.accountId };
		}
		ctx.log.warn("Stripe key health check failed", { error: String(error) });
		return { ...base, ok: false, error: "STRIPE_UNAVAILABLE" };
	}
}

// ─── Connect ─────────────────────────────────────────────────────

export async function adminConnectHandler(ctx: RCtx) {
	const input = body(ctx);
	const params = isRecord(input.params) ? input.params : {};

	switch (actionOf(input, "")) {
		case "start-connect": {
			const environment = input.environment === "sandbox" ? "sandbox" : "live";
			const siteOrigin = requireSiteOrigin(ctx);
			const state = await issueFlowState(ctx, "connect", environment, ctx.user?.id ?? null);
			return {
				url: buildAuthorizeUrl({
					environment,
					siteName: ctx.site.name || new URL(siteOrigin).hostname,
					returnUrl: settingsReturnUrl(siteOrigin, state),
				}),
			};
		}

		case "start-disconnect": {
			const config = await getStripeConfig(ctx);
			if (!config || config.keySource !== "connect" || !config.accountId) {
				fail("NOT_CONNECTED", "This site is not connected through Stripe Connect.", 409);
			}
			const siteOrigin = requireSiteOrigin(ctx);
			const state = await issueFlowState(ctx, "disconnect", config.environment, ctx.user?.id ?? null);
			return {
				url: buildDisconnectUrl({
					environment: config.environment,
					accountId: config.accountId,
					keyHash: config.keyHash,
					returnUrl: settingsReturnUrl(siteOrigin, state),
				}),
			};
		}

		case "complete-connect": {
			const flow = await consumeFlowState(ctx, params[STATE_PARAM], "connect", ctx.user?.id ?? null);
			if (!flow) {
				fail("INVALID_STATE", "This Stripe Connect response was not started by you on this site, or it expired. Start again.");
			}
			const result = parseConnectReturn(params, flow.environment);
			if (!result.ok) return { ok: false, message: result.message };
			const stripe = new StripeClient(result.accessToken, requireHttp(ctx).fetch);
			const account = await stripeCall(ctx, "account verification", () => stripe.getAccount());
			if (account.id !== result.accountId) {
				fail("ACCOUNT_MISMATCH", "The Stripe key does not belong to the returned account.");
			}
			await saveStripeKey(ctx, {
				secretKey: result.accessToken,
				keySource: "connect",
				environment: result.environment,
				accountId: result.accountId,
				publishableKey: result.publishableKey,
				connectHashed: result.hashed,
			});
			return { ok: true, message: "Connected to Stripe.", settings: await describeSettings(ctx) };
		}

		case "complete-disconnect": {
			const flow = await consumeFlowState(ctx, params[STATE_PARAM], "disconnect", ctx.user?.id ?? null);
			if (!flow) {
				fail("INVALID_STATE", "This disconnect response was not started by you on this site, or it expired. Start again.");
			}
			const config = await getStripeConfig(ctx);
			const connectedAccount = config?.keySource === "connect" ? config.accountId : null;
			const result = parseDisconnectReturn(params, connectedAccount);
			if (result.action === "keep") {
				return { ok: false, cleared: false, cancelled: result.cancelled, message: result.message };
			}
			await clearStripeKey(ctx);
			return { ok: true, cleared: true, message: "Disconnected from Stripe.", settings: await describeSettings(ctx) };
		}

		default:
			fail("UNKNOWN_ACTION", "Unknown connect action.");
	}
}

// ─── Products ────────────────────────────────────────────────────

export async function adminProductsHandler(ctx: RCtx) {
	const { config, stripe } = await requireStripe(ctx);
	const products = await stripeCall(ctx, "product listing", () =>
		getActiveProducts(ctx, stripe, config.keyHash, { fresh: true }),
	);
	return { products };
}

// ─── Restrictions ────────────────────────────────────────────────

function entryRef(input: Record<string, unknown>): { collection: string; id: string } {
	const { collection, id } = input;
	if (!isShortString(collection, 128) || !ENTRY_PART.test(collection) || !isShortString(id, 128) || !ENTRY_PART.test(id)) {
		fail("INVALID_INPUT", "collection and id are required.");
	}
	return { collection, id };
}

export async function adminRestrictionsHandler(ctx: RCtx) {
	const input = body(ctx);
	const restrictions = store<Restriction>(ctx, "restrictions");

	switch (actionOf(input, "list")) {
		case "list": {
			const all = await listRestrictions(ctx);
			const items = await Promise.all(
				all.map(async (restriction, index) => {
					let title: string | null = null;
					let slug: string | null = null;
					if (ctx.content && index < MAX_TITLE_LOOKUPS) {
						try {
							const entry = await ctx.content.get(restriction.collectionSlug, restriction.contentId);
							slug = entry?.slug ?? null;
							const value = entry?.data?.title;
							title = typeof value === "string" ? value : null;
						} catch {
							// Deleted entries and unknown collections still list by ID.
						}
					}
					return { ...restriction, title, slug };
				}),
			);
			return { items };
		}

		case "get": {
			const { collection, id } = entryRef(input);
			const restriction = await restrictions.get(restrictionKey(collection, id));
			return { productIds: restriction?.productIds ?? [] };
		}

		case "set": {
			const { collection, id } = entryRef(input);
			const raw = Array.isArray(input.productIds) ? input.productIds : null;
			if (!raw || raw.length > MAX_PRODUCTS_PER_RESTRICTION || !raw.every((value) => isStripeId("product", value))) {
				fail("INVALID_INPUT", "productIds must be a list of Stripe product IDs.");
			}
			const productIds = [...new Set(raw as string[])];
			if (productIds.length === 0) {
				await restrictions.delete(restrictionKey(collection, id));
			} else {
				await restrictions.put(restrictionKey(collection, id), {
					collectionSlug: collection,
					contentId: id,
					productIds,
					updatedAt: new Date().toISOString(),
				});
			}
			return { productIds };
		}

		case "delete": {
			const { collection, id } = entryRef(input);
			await restrictions.delete(restrictionKey(collection, id));
			return { productIds: [] };
		}

		default:
			fail("UNKNOWN_ACTION", "Unknown restrictions action.");
	}
}
