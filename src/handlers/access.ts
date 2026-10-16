// POST access {collection, id, session?}: is this entry restricted, and does the
// session's email hold one of the required products in Stripe?

import { getStripeConfig } from "../lib/config.js";
import { type Ctx, fail, type RCtx, requireHttp, store } from "../lib/context.js";
import { sha256Hex } from "../lib/crypto.js";
import { getRestrictedProductIds } from "../lib/restrictions.js";
import { getSession, type SessionIdentity } from "../lib/sessions.js";
import { notePermissionError } from "../lib/permissions.js";
import { StripeClient } from "../lib/stripe.js";
import { isShortString } from "../lib/validate.js";
import { body } from "./util.js";

const ACCESS_CACHE_TTL_MS = 5 * 60 * 1000;

export interface AccessResult {
	restricted: boolean;
	hasAccess: boolean;
	productIds: string[];
	email?: string;
	error?: "STRIPE_NOT_CONFIGURED" | "STRIPE_UNAVAILABLE";
}

export async function accessHandler(ctx: RCtx): Promise<AccessResult> {
	const input = body(ctx);
	const { collection, id } = input;
	if (!isShortString(collection) || !isShortString(id)) {
		fail("INVALID_INPUT", "collection and id are required.");
	}

	const productIds = await getRestrictedProductIds(ctx, collection, id);
	if (productIds.length === 0) return { restricted: false, hasAccess: true, productIds: [] };

	const identity = await getSession(ctx, input.session);
	if (!identity) return { restricted: true, hasAccess: false, productIds };

	const check = await identityHasAccess(ctx, identity, productIds);
	const result: AccessResult = { restricted: true, hasAccess: check.hasAccess, productIds, email: identity.email };
	if (check.error) result.error = check.error;
	return result;
}

/**
 * Positive results are cached for five minutes per Stripe key, session scope, and
 * product set; negatives are not.
 */
export async function identityHasAccess(
	ctx: Ctx,
	identity: SessionIdentity,
	productIds: readonly string[],
	now = Date.now(),
): Promise<{ hasAccess: boolean; error?: AccessResult["error"] }> {
	const config = await getStripeConfig(ctx);
	if (!config) return { hasAccess: false, error: "STRIPE_NOT_CONFIGURED" };

	const cache = store<{ expiresAt: string }>(ctx, "accessCache");
	const scope = identity.customerId ? `customer:${identity.customerId}` : `email:${identity.lookupEmails.join(",")}`;
	const cacheKey = await sha256Hex(`${config.keyHash}\n${scope}\n${[...productIds].sort().join(",")}`);
	const cached = await cache.get(cacheKey);
	if (cached && Date.parse(cached.expiresAt) > now) return { hasAccess: true };

	const stripe = new StripeClient(config.secretKey, requireHttp(ctx).fetch);
	try {
		for (const customerId of await stripe.customersFor(identity)) {
			if (await stripe.customerHasProduct(customerId, productIds)) {
				await cache.put(cacheKey, { expiresAt: new Date(now + ACCESS_CACHE_TTL_MS).toISOString() });
				return { hasAccess: true };
			}
		}
	} catch (error) {
		ctx.log.warn("Stripe access lookup failed", { error: String(error) });
		await notePermissionError(ctx, "access check", error);
		return { hasAccess: false, error: "STRIPE_UNAVAILABLE" };
	}
	return { hasAccess: false };
}
