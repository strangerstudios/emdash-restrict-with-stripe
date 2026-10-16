// POST checkout: start a Stripe Checkout Session for a product that restricts content.
// POST checkout/complete: verify a finished Checkout Session and issue a member session.

import { requireStripe } from "../lib/config.js";
import { fail, type RCtx, requireSiteOrigin, store } from "../lib/context.js";
import { sha256Hex } from "../lib/crypto.js";
import { maybePurgeExpired } from "../lib/cleanup.js";
import { checkLimits, WINDOW_15_MIN } from "../lib/ratelimit.js";
import { referencedProductIds } from "../lib/restrictions.js";
import { createSession } from "../lib/sessions.js";
import type { StripeCheckoutSession, StripeCustomer } from "../lib/stripe.js";
import { appendRawParam, isStripeId, normalizeEmail, validateReturnPath } from "../lib/validate.js";
import { body, stripeCall } from "./util.js";

export const CHECKOUT_PARAM = "rwstripe_checkout";
export const CHECKOUT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// Consumed-session markers outlive the freshness window so a replay is always caught.
const CONSUMED_TTL_MS = CHECKOUT_MAX_AGE_MS + 60 * 60 * 1000;

export async function checkoutHandler(ctx: RCtx): Promise<{ url: string }> {
	const input = body(ctx);
	const siteOrigin = requireSiteOrigin(ctx);
	const email = normalizeEmail(input.email);
	if (!email) fail("INVALID_EMAIL", "Enter a valid email address.");
	if (!isStripeId("price", input.price_id)) fail("INVALID_PRICE", "Choose a product to purchase.");
	const returnPath = validateReturnPath(input.return_path, siteOrigin);
	if (!returnPath) fail("INVALID_RETURN_PATH", "return_path must be a path on this site.");
	const priceId = input.price_id;

	const allowed = await checkLimits(ctx, "checkout", {
		email: { value: email, rule: { max: 5, windowMs: WINDOW_15_MIN } },
		ip: { max: 20, windowMs: WINDOW_15_MIN },
	});
	if (!allowed) fail("RATE_LIMITED", "Too many checkout attempts. Try again in a few minutes.", 429);

	const { stripe } = await requireStripe(ctx);
	const price = await stripeCall(ctx, "price lookup", () => stripe.getPriceWithProduct(priceId));
	const product = typeof price.product === "string" ? null : price.product;
	const productId = typeof price.product === "string" ? price.product : price.product.id;
	if (!price.active || (product && !product.active)) {
		fail("PRICE_UNAVAILABLE", "That product is not available for purchase.");
	}
	if (!(await referencedProductIds(ctx)).has(productId)) {
		fail("PRICE_UNAVAILABLE", "That product is not available for purchase.");
	}

	// The buyer has not proven they own this email, so never attach the checkout to an
	// existing customer: Stripe creates a fresh one when the session completes, and the
	// session issued by checkout/complete is scoped to that customer alone.
	const pageUrl = `${siteOrigin}${returnPath}`;
	const params: Record<string, string> = {
		customer_email: email,
		"line_items[0][price]": priceId,
		"line_items[0][quantity]": "1",
		success_url: appendRawParam(pageUrl, CHECKOUT_PARAM, "{CHECKOUT_SESSION_ID}"),
		cancel_url: pageUrl,
		"metadata[rwstripe]": "1",
	};
	if (price.type === "recurring") {
		params.mode = "subscription";
		params.payment_method_collection = "if_required";
	} else {
		params.mode = "payment";
		params.customer_creation = "always";
		// Without an invoice, a one-time purchase never shows up as a paid invoice
		// and customerHasProduct() would not grant access.
		params["invoice_creation[enabled]"] = "true";
	}

	const session = await stripeCall(ctx, "checkout session creation", () =>
		stripe.createCheckoutSession(params),
	);
	if (!session.url) fail("STRIPE_ERROR", "Stripe did not return a checkout URL.", 502);
	return { url: session.url };
}

export type CheckoutVerdict =
	| { ok: true; email: string; customerId: string }
	| { ok: false; code: string; message: string };

/** Pure checks on a retrieved Checkout Session (everything except single use). */
export function verifyCheckoutSession(session: StripeCheckoutSession, now = Date.now()): CheckoutVerdict {
	if (session.metadata?.rwstripe !== "1") {
		return { ok: false, code: "CHECKOUT_NOT_RECOGNIZED", message: "This checkout was not started by this site." };
	}
	if (session.status !== "complete") {
		return { ok: false, code: "CHECKOUT_INCOMPLETE", message: "This checkout has not been completed." };
	}
	if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
		return { ok: false, code: "CHECKOUT_UNPAID", message: "Payment for this checkout has not completed." };
	}
	if (typeof session.created !== "number" || now - session.created * 1000 > CHECKOUT_MAX_AGE_MS) {
		return { ok: false, code: "CHECKOUT_EXPIRED", message: "This checkout link has expired. Log in with your email instead." };
	}
	const customer = session.customer as StripeCustomer | string | null;
	const customerId = typeof customer === "string" ? customer : customer?.deleted ? null : (customer?.id ?? null);
	if (!customerId) {
		return { ok: false, code: "CHECKOUT_NO_CUSTOMER", message: "Stripe did not create a customer for this checkout." };
	}
	const email = normalizeEmail(
		(typeof customer === "object" && customer && !customer.deleted ? customer.email : null) ??
			session.customer_details?.email,
	);
	if (!email) {
		return { ok: false, code: "CHECKOUT_NO_EMAIL", message: "Stripe did not return an email for this checkout." };
	}
	return { ok: true, email, customerId };
}

export async function checkoutCompleteHandler(
	ctx: RCtx,
): Promise<{ session: string; email: string; expiresAt: string }> {
	const input = body(ctx);
	if (!isStripeId("checkoutSession", input.session_id)) {
		fail("INVALID_SESSION_ID", "A Stripe Checkout Session ID is required.");
	}
	const sessionId = input.session_id;

	const allowed = await checkLimits(ctx, "checkout-complete", {
		ip: { max: 10, windowMs: WINDOW_15_MIN },
	});
	if (!allowed) fail("RATE_LIMITED", "Too many attempts. Try again in a few minutes.", 429);

	const { stripe } = await requireStripe(ctx);
	const checkout = await stripeCall(ctx, "checkout session lookup", () =>
		stripe.getCheckoutSession(sessionId),
	);
	const verdict = verifyCheckoutSession(checkout);
	if (!verdict.ok) fail(verdict.code, verdict.message);

	const perEmail = await checkLimits(ctx, "checkout-complete", {
		email: { value: verdict.email, rule: { max: 5, windowMs: WINDOW_15_MIN } },
	});
	if (!perEmail) fail("RATE_LIMITED", "Too many attempts. Try again in a few minutes.", 429);

	// Single use: create-if-absent on sha256(session id); a second redemption finds the row.
	const now = Date.now();
	const claimed = await store<{ consumedAt: string; expiresAt: string }>(ctx, "consumedCheckouts").compareAndSet(
		await sha256Hex(sessionId),
		null,
		{ consumedAt: new Date(now).toISOString(), expiresAt: new Date(now + CONSUMED_TTL_MS).toISOString() },
	);
	if (!claimed.applied) {
		fail("CHECKOUT_ALREADY_USED", "This checkout has already been used to log in. Log in with your email instead.", 409);
	}

	await maybePurgeExpired(ctx);
	const session = await createSession(ctx, verdict.email, now, { customerId: verdict.customerId });
	return { session: session.token, email: verdict.email, expiresAt: session.expiresAt };
}
