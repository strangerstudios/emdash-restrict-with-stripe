// Runtime definition, loaded by EmDash through the descriptor's entrypoint.

import { definePlugin } from "emdash";
import type { PageFragmentContribution } from "emdash";

import { EARLY_JS, ONE_TIME_PARAMS, PAYWALL_CSS, PENDING_JS, paywallScript } from "./client/paywall.js";
import { accessHandler } from "./handlers/access.js";
import {
	adminConnectHandler,
	adminKeyHealthHandler,
	adminPermissionsHandler,
	adminProductsHandler,
	adminRestrictionsHandler,
	adminSettingsHandler,
} from "./handlers/admin.js";
import { logoutHandler, sendLinkHandler, verifyHandler } from "./handlers/auth.js";
import { checkoutCompleteHandler, checkoutHandler } from "./handlers/checkout.js";
import { portalHandler } from "./handlers/portal.js";
import { productsHandler } from "./handlers/products.js";
import { getShowExcerpts, readSecretKey, SECRET_KEY_SETTING, SHOW_EXCERPTS_SETTING } from "./lib/config.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./lib/context.js";
import { getRestrictedProductIds } from "./lib/restrictions.js";

export const ADMIN_ENTRY = "emdash-restrict-with-stripe/admin";
const API_BASE = `/_emdash/api/plugins/${PLUGIN_ID}`;
const POST: ["POST"] = ["POST"];

export function createPlugin(_options: Record<string, unknown> = {}) {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: ["content:read", "network:request", "hooks.page-fragments:register", "email:send"],
		allowedHosts: ["api.stripe.com"],

		storage: {
			restrictions: { indexes: ["collectionSlug", "contentId", "updatedAt"] },
			loginTokens: { indexes: ["expiresAt"] },
			sessions: { indexes: ["email", "expiresAt"] },
			consumedCheckouts: { indexes: ["expiresAt"] },
			rateLimits: { indexes: ["expiresAt"] },
			accessCache: { indexes: ["expiresAt"] },
		},

		hooks: {
			"page:fragments": async ({ page }, ctx) => {
				if (page.kind !== "content" || !page.content || page.path.startsWith("/_emdash")) return null;
				let secretKey: string | null;
				try {
					secretKey = await readSecretKey(ctx);
				} catch {
					return null;
				}
				if (!secretKey) return null;

				const { collection, id, slug } = page.content;
				const restricted = (await getRestrictedProductIds(ctx, collection, id)).length > 0;
				const fragments: PageFragmentContribution[] = [
					{ kind: "inline-script", placement: "head", key: "rwstripe-early", code: EARLY_JS },
					{ kind: "html", placement: "head", key: "rwstripe-css", html: `<style>${PAYWALL_CSS}</style>` },
				];
				if (hasOneTimeParam(page.url)) {
					// Keep the Checkout Session ID or login token out of Referer headers.
					fragments.push({
						kind: "html",
						placement: "head",
						key: "rwstripe-referrer",
						html: `<meta name="referrer" content="no-referrer">`,
					});
				}
				if (restricted) {
					fragments.push({ kind: "inline-script", placement: "head", key: "rwstripe-pending", code: PENDING_JS });
				}
				fragments.push({
					kind: "inline-script",
					placement: "body:end",
					key: "rwstripe-paywall",
					code: paywallScript({
						api: API_BASE,
						content: { collection, id, slug: slug ?? null },
						showExcerpts: await getShowExcerpts(ctx),
					}),
				});
				return fragments;
			},
		},

		routes: {
			access: { public: true, methods: POST, handler: accessHandler },
			products: { public: true, methods: ["GET", "POST"], handler: productsHandler },
			checkout: { public: true, methods: POST, handler: checkoutHandler },
			"checkout/complete": { public: true, methods: POST, handler: checkoutCompleteHandler },
			"auth/send-link": { public: true, methods: POST, handler: sendLinkHandler },
			"auth/verify": { public: true, methods: POST, handler: verifyHandler },
			"auth/logout": { public: true, methods: POST, handler: logoutHandler },
			portal: { public: true, methods: POST, handler: portalHandler },

			"admin/settings": { methods: POST, handler: adminSettingsHandler },
			"admin/restrictions": { methods: POST, handler: adminRestrictionsHandler },
			"admin/products": { methods: POST, handler: adminProductsHandler },
			"admin/connect": { methods: POST, handler: adminConnectHandler },
			"admin/key-health": { methods: POST, handler: adminKeyHealthHandler },
			"admin/permissions": { methods: POST, handler: adminPermissionsHandler },
		},

		admin: {
			entry: ADMIN_ENTRY,
			settingsSchema: {
				[SECRET_KEY_SETTING]: {
					type: "secret",
					label: "Stripe secret key",
					description:
						"Filled in by Stripe Connect on the Restrict With Stripe settings page. Paste a secret or restricted key here only for manual setup.",
				},
				[SHOW_EXCERPTS_SETTING]: {
					type: "boolean",
					label: "Show excerpts on restricted content",
					default: true,
				},
			},
			pages: [
				{ path: "/settings", label: "Restrict With Stripe", icon: "lock" },
				{ path: "/restrictions", label: "Restricted Content", icon: "lock-key" },
			],
			widgets: [{ id: "overview", title: "Restrict With Stripe", size: "half" }],
		},
	});
}

function hasOneTimeParam(url: string): boolean {
	try {
		const { searchParams } = new URL(url);
		return ONE_TIME_PARAMS.some((name) => searchParams.has(name));
	} catch {
		return false;
	}
}

export default createPlugin;
