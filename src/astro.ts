// Server-side access check for Astro templates. Reads the member session cookie and
// calls the plugin's public `access` route in-process, so restricted text can be
// left out of the HTML instead of only being hidden by the paywall script.

import { getPublicPluginApiRouteHandler, type PublicPluginRuntimeLocals } from "emdash/plugin-utils";

import { PLUGIN_ID } from "./lib/context.js";

export const SESSION_COOKIE = "rwstripe_session";

export interface AccessCheck {
	restricted: boolean;
	hasAccess: boolean;
	productIds: string[];
	email?: string;
	error?: string;
}

/** The parts of the Astro global this helper uses. */
export interface AstroLike {
	cookies: { get(name: string): { value: string } | undefined };
	locals: unknown;
	url: URL;
}

function isAccessCheck(value: unknown): value is AccessCheck {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.restricted === "boolean" && typeof record.hasAccess === "boolean" && Array.isArray(record.productIds);
}

/**
 * Check access to one entry for the current visitor. Fails closed: if the plugin
 * cannot be reached, the result is `{ restricted: true, hasAccess: false }`.
 * Pages that use this vary by cookie, so do not cache them publicly.
 */
export async function getAccess(
	astro: AstroLike,
	content: { collection: string; id: string },
): Promise<AccessCheck> {
	const denied = (error: string): AccessCheck => ({ restricted: true, hasAccess: false, productIds: [], error });
	const handler = getPublicPluginApiRouteHandler(astro.locals as PublicPluginRuntimeLocals);
	if (!handler) return denied("RUNTIME_UNAVAILABLE");

	const session = astro.cookies.get(SESSION_COOKIE)?.value;
	const request = new Request(new URL(`/_emdash/api/plugins/${PLUGIN_ID}/access`, astro.url), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ collection: content.collection, id: content.id, session }),
	});
	try {
		const result = await handler(PLUGIN_ID, "POST", "/access", request);
		if (!result.success || !isAccessCheck(result.data)) {
			return denied(result.error?.code ?? "ACCESS_CHECK_FAILED");
		}
		return result.data;
	} catch {
		return denied("ACCESS_CHECK_FAILED");
	}
}
