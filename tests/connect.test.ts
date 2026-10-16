import { describe, expect, it } from "vitest";

import { adminConnectHandler } from "../src/handlers/admin.js";
import { saveStripeKey } from "../src/lib/config.js";
import {
	buildAuthorizeUrl,
	buildDisconnectUrl,
	consumeFlowState,
	issueFlowState,
	parseConnectReturn,
	parseDisconnectReturn,
} from "../src/lib/connect.js";
import { sha256Hex } from "../src/lib/crypto.js";
import { createHarness, stripeFetch } from "./support/fake-ctx.js";

const TOKEN = "sk_test_connectedtoken123";

describe("connect URLs", () => {
	it("builds the authorize URL with a return URL that already has a query", () => {
		const url = new URL(
			buildAuthorizeUrl({
				environment: "sandbox",
				siteName: "My <Blog>",
				returnUrl: "https://example.test/_emdash/admin/plugins/restrict-with-stripe/settings?rwstripe_state=abc",
			}),
		);
		expect(url.origin).toBe("https://connect.restrictwithstripe.com");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			action: "authorize",
			gateway_environment: "sandbox",
			site_name: "My <Blog>",
			supports_hash: "1",
			return_url: "https://example.test/_emdash/admin/plugins/restrict-with-stripe/settings?rwstripe_state=abc",
		});
	});

	it("builds the disconnect URL with the key hash", async () => {
		const url = new URL(
			buildDisconnectUrl({
				environment: "live",
				accountId: "acct_123",
				keyHash: await sha256Hex(TOKEN),
				returnUrl: "https://example.test/x?rwstripe_state=s",
			}),
		);
		expect(url.searchParams.get("action")).toBe("disconnect");
		expect(url.searchParams.get("stripe_user_id")).toBe("acct_123");
		expect(url.searchParams.get("key_hash")).toBe(await sha256Hex(TOKEN));
	});
});

describe("flow state", () => {
	it("is single use and bound to its kind", async () => {
		const { ctx } = createHarness();
		const state = await issueFlowState(ctx, "connect", "live", "user1");
		expect(await consumeFlowState(ctx, state, "disconnect", "user1")).toBeNull();
		const again = await issueFlowState(ctx, "connect", "live", "user1");
		expect(await consumeFlowState(ctx, again, "connect", "user1")).toMatchObject({ environment: "live" });
		expect(await consumeFlowState(ctx, again, "connect", "user1")).toBeNull();
	});

	it("expires", async () => {
		const { ctx } = createHarness();
		const now = Date.now();
		const state = await issueFlowState(ctx, "disconnect", "live", "user1", now);
		expect(await consumeFlowState(ctx, state, "disconnect", "user1", now + 60 * 60 * 1000 + 1)).toBeNull();
	});

	it("belongs to the admin who started the flow", async () => {
		const { ctx } = createHarness();
		const state = await issueFlowState(ctx, "connect", "live", "user1");
		expect(await consumeFlowState(ctx, state, "connect", "user2")).toBeNull();
		expect(await consumeFlowState(ctx, state, "connect", "user1")).toBeNull();
	});
});

describe("parseConnectReturn", () => {
	const good = {
		pmpro_stripe_connected: "true",
		pmpro_stripe_access_token: TOKEN,
		pmpro_stripe_publishable_key: "pk_test_abcdefgh123",
		pmpro_stripe_user_id: "acct_123",
		pmpro_stripe_connected_environment: "sandbox",
		pmpro_stripe_connect_hashed: "true",
	};
	it("accepts a complete return", () => {
		expect(parseConnectReturn(good, "sandbox")).toMatchObject({ ok: true, accountId: "acct_123", hashed: true });
	});
	it("rejects an environment other than the one requested", () => {
		expect(parseConnectReturn(good, "live").ok).toBe(false);
	});
	it("rejects a live token on a sandbox return", () => {
		expect(parseConnectReturn({ ...good, pmpro_stripe_access_token: "sk_live_abcdefghijk" }, "sandbox").ok).toBe(false);
	});
	it("surfaces the server's error message", () => {
		expect(parseConnectReturn({ pmpro_stripe_connected: "false", error_message: "Stripe connection was cancelled." }, "live")).toEqual({
			ok: false,
			message: "Stripe connection was cancelled.",
		});
	});
});

describe("parseDisconnectReturn", () => {
	it("clears only on success for the connected account", () => {
		expect(parseDisconnectReturn({ pmpro_stripe_disconnected: "true", stripe_user_id: "acct_123" }, "acct_123")).toEqual({ action: "clear" });
		expect(parseDisconnectReturn({ pmpro_stripe_disconnected: "true", stripe_user_id: "acct_999" }, "acct_123")).toMatchObject({ action: "keep" });
		expect(parseDisconnectReturn({ pmpro_stripe_disconnected: "true" }, "acct_123")).toMatchObject({ action: "keep" });
		expect(parseDisconnectReturn({ pmpro_stripe_disconnected: "true", stripe_user_id: "acct_123" }, null)).toMatchObject({ action: "keep" });
	});
	it("keeps keys and reports cancellation", () => {
		expect(
			parseDisconnectReturn(
				{ pmpro_stripe_disconnected: "false", error_code: "cancelled", error_message: "Stripe disconnect was cancelled.", stripe_user_id: "acct_123" },
				"acct_123",
			),
		).toEqual({ action: "keep", cancelled: true, message: "Stripe disconnect was cancelled." });
	});
});

describe("admin/connect", () => {
	async function connected() {
		const h = createHarness({ fetch: stripeFetch({ "GET /account": () => ({ id: "acct_123" }) }) });
		await saveStripeKey(h.ctx, {
			secretKey: TOKEN,
			keySource: "connect",
			environment: "sandbox",
			accountId: "acct_123",
			publishableKey: null,
			connectHashed: true,
		});
		return h;
	}

	it("rejects a forged connect return without a state it issued", async () => {
		const h = createHarness({ fetch: stripeFetch({ "GET /account": () => ({ id: "acct_evil" }) }) });
		const params = {
			rwstripe_state: "made-up",
			pmpro_stripe_connected: "true",
			pmpro_stripe_access_token: "sk_live_attackerkey123",
			pmpro_stripe_user_id: "acct_evil",
			pmpro_stripe_connected_environment: "live",
		};
		await expect(adminConnectHandler(h.withInput({ action: "complete-connect", params }))).rejects.toMatchObject({ code: "INVALID_STATE" });
		expect(await h.settings.get("stripeSecretKey")).toBeNull();
	});

	it("saves keys for a return it requested and verifies the account", async () => {
		const h = createHarness({ fetch: stripeFetch({ "GET /account": () => ({ id: "acct_123" }) }) });
		const { url } = (await adminConnectHandler(h.withInput({ action: "start-connect", environment: "sandbox" }))) as { url: string };
		const returnUrl = new URL(new URL(url).searchParams.get("return_url")!);
		const params = {
			rwstripe_state: returnUrl.searchParams.get("rwstripe_state"),
			pmpro_stripe_connected: "true",
			pmpro_stripe_access_token: TOKEN,
			pmpro_stripe_user_id: "acct_123",
			pmpro_stripe_connected_environment: "sandbox",
			pmpro_stripe_connect_hashed: "true",
		};
		await expect(adminConnectHandler(h.withInput({ action: "complete-connect", params }))).resolves.toMatchObject({ ok: true });
		expect(await h.settings.get("stripeSecretKey")).toBe(TOKEN);
	});

	it("keeps keys until the server confirms the disconnect for this account", async () => {
		const h = await connected();
		const start = async () => {
			const { url } = (await adminConnectHandler(h.withInput({ action: "start-disconnect" }))) as { url: string };
			const target = new URL(url);
			expect(target.searchParams.get("key_hash")).toBe(await sha256Hex(TOKEN));
			return new URL(target.searchParams.get("return_url")!).searchParams.get("rwstripe_state");
		};

		// Starting a disconnect does not touch the keys.
		const cancelledState = await start();
		expect(await h.settings.get("stripeSecretKey")).toBe(TOKEN);

		const cancelled = await adminConnectHandler(
			h.withInput({
				action: "complete-disconnect",
				params: { rwstripe_state: cancelledState, pmpro_stripe_disconnected: "false", error_code: "cancelled", stripe_user_id: "acct_123" },
			}),
		);
		expect(cancelled).toMatchObject({ ok: false, cleared: false, cancelled: true });
		expect(await h.settings.get("stripeSecretKey")).toBe(TOKEN);

		const mismatchState = await start();
		const mismatch = await adminConnectHandler(
			h.withInput({
				action: "complete-disconnect",
				params: { rwstripe_state: mismatchState, pmpro_stripe_disconnected: "true", stripe_user_id: "acct_other" },
			}),
		);
		expect(mismatch).toMatchObject({ cleared: false });
		expect(await h.settings.get("stripeSecretKey")).toBe(TOKEN);

		await expect(
			adminConnectHandler(
				h.withInput({
					action: "complete-disconnect",
					params: { rwstripe_state: "forged", pmpro_stripe_disconnected: "true", stripe_user_id: "acct_123" },
				}),
			),
		).rejects.toMatchObject({ code: "INVALID_STATE" });

		const okState = await start();
		const done = await adminConnectHandler(
			h.withInput({
				action: "complete-disconnect",
				params: { rwstripe_state: okState, pmpro_stripe_disconnected: "true", stripe_user_id: "acct_123" },
			}),
		);
		expect(done).toMatchObject({ ok: true, cleared: true });
		expect(await h.settings.get("stripeSecretKey")).toBeNull();
	});
});
