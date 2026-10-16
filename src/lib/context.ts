import { PluginRouteError } from "emdash";
import type { PluginContext, RouteContext, StorageCollection } from "emdash";

import { siteOriginFrom } from "./validate.js";

export type Ctx = PluginContext;
export type RCtx = RouteContext;

export const PLUGIN_ID = "restrict-with-stripe";
export const PLUGIN_VERSION = "0.2.0";

export type CollectionName =
	| "restrictions"
	| "loginTokens"
	| "sessions"
	| "consumedCheckouts"
	| "rateLimits"
	| "accessCache";

export function store<T>(ctx: Ctx, name: CollectionName): StorageCollection<T> {
	const collection = ctx.storage[name];
	if (!collection) throw new Error(`Storage collection "${name}" is not declared`);
	return collection as StorageCollection<T>;
}

export function fail(code: string, message: string, status = 400): never {
	throw new PluginRouteError(code, message, status);
}

/** Absolute site origin for links we email or hand to Stripe. Never the request Host. */
export function requireSiteOrigin(ctx: Ctx): string {
	const origin = siteOriginFrom(ctx.site.url);
	if (!origin) {
		fail(
			"SITE_URL_NOT_CONFIGURED",
			"The site URL is not configured. Set siteUrl in astro.config.mjs, EMDASH_SITE_URL, or Settings > General.",
			503,
		);
	}
	return origin;
}

export function requireHttp(ctx: Ctx): NonNullable<Ctx["http"]> {
	if (!ctx.http) fail("NETWORK_UNAVAILABLE", "The network:request capability is not available.", 500);
	return ctx.http;
}
