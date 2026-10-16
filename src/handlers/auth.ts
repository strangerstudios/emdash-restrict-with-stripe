// Magic-link login for members.
//
//   POST auth/send-link {email, return_path} -> emails <site><return_path>?rwstripe_login=<token>
//   POST auth/verify    {token}              -> {session, email, expiresAt}
//   POST auth/logout    {session}            -> {ok}
//
// The page script reads rwstripe_login from the URL and POSTs it, so link
// scanners that prefetch the GET URL cannot burn the token.

import { getStripeConfig } from "../lib/config.js";
import { type Ctx, fail, type RCtx, requireHttp, requireSiteOrigin } from "../lib/context.js";
import { maybePurgeExpired } from "../lib/cleanup.js";
import { checkLimits, WINDOW_15_MIN } from "../lib/ratelimit.js";
import {
	LOGIN_TOKEN_TTL_MS,
	consumeLoginToken,
	createLoginToken,
	createSession,
	deleteSession,
} from "../lib/sessions.js";
import { notePermissionError } from "../lib/permissions.js";
import { StripeClient } from "../lib/stripe.js";
import { referencedProductIds } from "../lib/restrictions.js";
import { appendRawParam, emailLookupVariants, escapeHtml, normalizeEmail, validateReturnPath } from "../lib/validate.js";
import { body } from "./util.js";

export const LOGIN_PARAM = "rwstripe_login";

const GENERIC_SENT = {
	ok: true,
	message: "If that email has a purchase on this site, a login link is on its way.",
} as const;

export async function sendLinkHandler(ctx: RCtx): Promise<typeof GENERIC_SENT> {
	const input = body(ctx);
	const siteOrigin = requireSiteOrigin(ctx);
	const email = normalizeEmail(input.email);
	if (!email) fail("INVALID_EMAIL", "Enter a valid email address.");
	const returnPath = validateReturnPath(input.return_path, siteOrigin);
	if (!returnPath) fail("INVALID_RETURN_PATH", "return_path must be a path on this site.");
	if (!ctx.email) {
		fail("EMAIL_NOT_CONFIGURED", "This site cannot send email yet, so login links are unavailable.", 503);
	}
	const config = await getStripeConfig(ctx);
	if (!config) fail("STRIPE_NOT_CONFIGURED", "Stripe is not connected for this site.", 503);

	const allowed = await checkLimits(ctx, "send-link", {
		email: { value: email, rule: { max: 3, windowMs: WINDOW_15_MIN } },
		ip: { max: 10, windowMs: WINDOW_15_MIN },
	});
	if (!allowed) {
		ctx.log.info("Login link rate limited");
		return GENERIC_SENT;
	}
	await maybePurgeExpired(ctx);

	// Mail goes only to addresses whose Stripe customers hold a product that restricts
	// content, so the route cannot send login email to arbitrary addresses (customers
	// alone are not enough: anyone can create one by completing a free checkout).
	// The response is identical either way.
	const lookupEmails = emailLookupVariants(input.email);
	try {
		const stripe = new StripeClient(config.secretKey, requireHttp(ctx).fetch);
		const products = [...(await referencedProductIds(ctx))];
		let eligible = false;
		for (const customerId of await stripe.customersFor({ customerId: null, lookupEmails })) {
			if (await stripe.customerHasProduct(customerId, products)) {
				eligible = true;
				break;
			}
		}
		if (!eligible) return GENERIC_SENT;
	} catch (error) {
		ctx.log.warn("Stripe lookup for login link failed", { error: String(error) });
		await notePermissionError(ctx, "login link lookup", error);
		return GENERIC_SENT;
	}

	const token = await createLoginToken(ctx, email, returnPath, Date.now(), lookupEmails);
	const link = appendRawParam(`${siteOrigin}${returnPath}`, LOGIN_PARAM, token);
	await sendLoginEmail(ctx, email, link);
	return GENERIC_SENT;
}

async function sendLoginEmail(ctx: Ctx, to: string, link: string): Promise<void> {
	const siteName = ctx.site.name || new URL(link).hostname;
	const minutes = LOGIN_TOKEN_TTL_MS / 60000;
	const text = [
		`Log in to ${siteName}: ${link}`,
		"",
		`This link expires in ${minutes} minutes and works once. If you didn't request it, you can ignore this email.`,
	].join("\n");
	const html = [
		`<p>Click the button below to log in to ${escapeHtml(siteName)}.</p>`,
		`<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 20px;background:#635bff;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:500">Log In</a></p>`,
		`<p style="color:#6b7280;font-size:13px">This link expires in ${minutes} minutes and works once. If you didn't request it, you can ignore this email.</p>`,
	].join("\n");
	try {
		await ctx.email!.send({ to, subject: `Your login link for ${siteName}`, text, html });
	} catch (error) {
		// Not surfaced to the caller: a distinct error here would reveal that the address is a customer.
		ctx.log.error("Login email failed to send", { error: String(error) });
	}
}

export async function verifyHandler(
	ctx: RCtx,
): Promise<{ session: string; email: string; expiresAt: string; returnPath: string }> {
	const input = body(ctx);
	const allowed = await checkLimits(ctx, "verify", { ip: { max: 20, windowMs: WINDOW_15_MIN } });
	if (!allowed) fail("RATE_LIMITED", "Too many attempts. Try again in a few minutes.", 429);

	const record = await consumeLoginToken(ctx, input.token);
	if (!record) {
		fail("INVALID_LOGIN_LINK", "This login link is invalid, expired, or already used. Request a new one.");
	}
	const session = await createSession(ctx, record.email, Date.now(), { lookupEmails: record.lookupEmails });
	return { session: session.token, email: record.email, expiresAt: session.expiresAt, returnPath: record.returnPath };
}

export async function logoutHandler(ctx: RCtx): Promise<{ ok: true }> {
	await deleteSession(ctx, body(ctx).session);
	return { ok: true };
}
