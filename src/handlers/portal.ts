// POST portal {session, return_path}: Stripe billing portal URL for the session's customer.

import { PORTAL_CONFIG_KEY, requireStripe } from "../lib/config.js";
import { fail, type RCtx, requireSiteOrigin } from "../lib/context.js";
import { getSession } from "../lib/sessions.js";
import { validateReturnPath } from "../lib/validate.js";
import { body, stripeCall } from "./util.js";

export async function portalHandler(ctx: RCtx): Promise<{ url: string }> {
	const input = body(ctx);
	const siteOrigin = requireSiteOrigin(ctx);
	const returnPath = validateReturnPath(input.return_path, siteOrigin);
	if (!returnPath) fail("INVALID_RETURN_PATH", "return_path must be a path on this site.");
	const identity = await getSession(ctx, input.session);
	if (!identity) fail("NOT_LOGGED_IN", "Log in to manage your purchases.", 401);

	const { config, stripe } = await requireStripe(ctx);
	const customers = await stripeCall(ctx, "customer lookup", () => stripe.customersFor(identity));
	const customerId = customers[0];
	if (!customerId) fail("NO_CUSTOMER", "No purchases were found for this email.", 404);

	// Cached per key so a different Stripe account never reuses another's configuration.
	const cached = await ctx.kv.get<{ keyHash: string; id: string }>(PORTAL_CONFIG_KEY);
	let configuration = cached?.keyHash === config.keyHash ? cached.id : null;
	if (!configuration) {
		configuration = await stripeCall(ctx, "portal configuration", () => stripe.ensurePortalConfiguration());
		await ctx.kv.set(PORTAL_CONFIG_KEY, { keyHash: config.keyHash, id: configuration });
	}
	const configurationId = configuration;
	const portal = await stripeCall(ctx, "portal session", () =>
		stripe.createPortalSession(customerId, `${siteOrigin}${returnPath}`, configurationId),
	);
	return { url: portal.url };
}
