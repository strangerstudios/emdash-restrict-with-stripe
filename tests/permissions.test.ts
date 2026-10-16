import { describe, expect, it } from "vitest";

import { adminKeyHealthHandler, adminPermissionsHandler, adminSettingsHandler, rejectedKeyHealth } from "../src/handlers/admin.js";
import { checkoutHandler } from "../src/handlers/checkout.js";
import { saveStripeKey } from "../src/lib/config.js";
import { REQUIRED_PERMISSIONS } from "../src/lib/permission-list.js";
import { mapProbeResult, parsePermissionError, PERMISSION_ERROR_KEY } from "../src/lib/permissions.js";
import { StripeApiError } from "../src/lib/stripe.js";
import { createHarness, stripeFetch } from "./support/fake-ctx.js";

const RK = "rk_test_restrictedkey123";

function permissionMessage(permission: string) {
	return `The provided key 'rk_test_*******************y123' does not have the required permissions for this endpoint on account 'acct_1'. Having the '${permission}' permission would allow this request to continue.`;
}

function forbidden(permission: string) {
	return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: permissionMessage(permission) } }), { status: 403 });
}

const byResource = (resource: string) => REQUIRED_PERMISSIONS.find((p) => p.resource === resource)!;

describe("parsePermissionError", () => {
	it("names the missing permission from Stripe's 403 message", () => {
		const error = new StripeApiError(403, "invalid_request_error", undefined, permissionMessage("rak_checkout_session_write"));
		expect(parsePermissionError(error)).toEqual({ resource: "checkout_session", access: "write", label: "Checkout Sessions: Write" });
	});
	it("maps Stripe's plan resource to Prices and humanizes unknown resources", () => {
		// Real sandbox wording captured 2026-10-16 (code more_permissions_required).
		const real = (label: string, id: string) =>
			new StripeApiError(403, "invalid_request_error", "more_permissions_required", `Permission denied. The provided key 'rk_test_...BkPi' does not have the required permissions for this endpoint on account 'acct_1'. Enabling ${label} ('${id}') permissions on this key would allow this request to continue. You can edit permissions at https://dashboard.stripe.com/b/acct_1?destination=%2Ftest%2Fapikeys%2Fmk_1%2Fedit`);
		expect(parsePermissionError(real("Charges and Refunds Read", "charge_read"))).toEqual({ resource: "charge", access: "read", label: "Charges and Refunds: Read" });
		expect(parsePermissionError(real("Prices Read", "plan_read"))?.label).toBe("Prices: Read");
		expect(parsePermissionError(real("Checkout Sessions Write", "checkout_session_write"))?.label).toBe("Checkout Sessions: Write");
		expect(parsePermissionError(new StripeApiError(403, undefined, undefined, permissionMessage("rak_plan_read")))?.label).toBe("Prices: Read");
		expect(parsePermissionError(new StripeApiError(403, undefined, undefined, permissionMessage("rak_tax_rate_read")))?.label).toBe("Tax Rate: Read");
		expect(parsePermissionError(new StripeApiError(403, undefined, undefined, permissionMessage("customer_portal_write")))?.label).toBe("Customer Portal: Write");
	});
	it("ignores non-403 errors and 403s that name no permission", () => {
		expect(parsePermissionError(new StripeApiError(400, undefined, undefined, permissionMessage("rak_product_read")))).toBeNull();
		expect(parsePermissionError(new StripeApiError(403, undefined, undefined, "Forbidden"))).toBeNull();
		expect(parsePermissionError(new Error(permissionMessage("rak_product_read")))).toBeNull();
	});
});

describe("mapProbeResult", () => {
	it("reports a readable permission as ok and a write permission as not verifiable until first use", () => {
		expect(mapProbeResult(byResource("product"), { ok: true })).toMatchObject({ label: "Products: Read", status: "ok" });
		expect(mapProbeResult(byResource("checkout_session"), { ok: true })).toMatchObject({
			label: "Checkout Sessions: Write",
			status: "unverified",
			message: expect.stringContaining("not verifiable until first use"),
		});
	});
	it("reports a 403 as missing with Stripe's named permission", () => {
		const error = new StripeApiError(403, undefined, undefined, permissionMessage("rak_customer_portal_read"));
		expect(mapProbeResult(byResource("customer_portal"), { ok: false, error })).toMatchObject({
			label: "Customer Portal: Write",
			status: "missing",
			message: "Missing. Stripe reports the key needs Customer Portal: Read.",
		});
	});
	it("marks the optional account permission as optional and other failures as unknown", () => {
		const error = new StripeApiError(403, undefined, undefined, "Forbidden");
		expect(mapProbeResult(byResource("connected_account"), { ok: false, error })).toMatchObject({ optional: true, status: "missing" });
		expect(mapProbeResult(byResource("invoice"), { ok: false, error: new StripeApiError(500, undefined, undefined, "boom") })).toMatchObject({ status: "error" });
	});
});

describe("check key permissions route", () => {
	it("probes with read-only limit=1 GETs and reports per permission", async () => {
		const calls: Parameters<typeof stripeFetch>[1] = [];
		const list = () => ({ data: [], has_more: false });
		const harness = createHarness({
			fetch: stripeFetch(
				{
					"GET /products": list,
					"GET /prices": list,
					"GET /customers": list,
					"GET /subscriptions": () => forbidden("rak_subscription_read"),
					"GET /invoices": list,
					"GET /checkout/sessions": list,
					"GET /billing_portal/configurations": list,
					"GET /account": () => forbidden("rak_connected_account_read"),
				},
				calls,
			),
		});
		await harness.settings.put("stripeSecretKey", RK);
		const { report } = await adminPermissionsHandler(harness.ctx);
		expect(calls.every((call) => call.method === "GET")).toBe(true);
		expect(calls.filter((call) => call.path !== "/account").every((call) => call.url.searchParams.get("limit") === "1")).toBe(true);
		expect(report.ok).toBe(false);
		expect(Object.fromEntries(report.results.map((r) => [r.label, r.status]))).toEqual({
			"Products: Read": "ok",
			"Prices: Read": "ok",
			"Customers: Read": "ok",
			"Subscriptions: Read": "missing",
			"Invoices: Read": "ok",
			"Checkout Sessions: Write": "unverified",
			"Customer Portal: Write": "unverified",
			"Accounts: Read": "missing",
		});
	});

	it("runs automatically after saving a restricted key and stops on a rejected key", async () => {
		const harness = createHarness({
			fetch: stripeFetch({
				"GET /account": () => forbidden("rak_connected_account_read"),
				"GET /products": () => new Response(JSON.stringify({ error: { message: "Invalid API Key provided" } }), { status: 401 }),
			}),
		});
		const settings = await adminSettingsHandler(harness.withInput({ action: "save", secretKey: RK }));
		expect(settings.permissionReport).toMatchObject({ keyType: "restricted", invalidKey: true, ok: false, results: [] });
	});
});

describe("runtime permission errors", () => {
	it("records the missing permission for admins and keeps the visitor error generic", async () => {
		const harness = createHarness({
			input: { email: "buyer@example.test", price_id: "price_1", return_path: "/post" },
			fetch: stripeFetch({
				"GET /prices/price_1": () => ({ id: "price_1", active: true, type: "one_time", product: { id: "prod_1", active: true } }),
				"POST /checkout/sessions": () => forbidden("rak_checkout_session_write"),
			}),
		});
		await harness.settings.put("stripeSecretKey", RK);
		await harness.stores.restrictions.put("posts:1", { collectionSlug: "posts", contentId: "1", productIds: ["prod_1"], updatedAt: "" });
		const error = (await checkoutHandler(harness.ctx).catch((thrown: unknown) => thrown)) as Error & { code: string };
		expect(error).toMatchObject({ code: "STRIPE_ERROR" });
		expect(error.message).not.toMatch(/permission|Checkout Sessions/i);
		const stored = harness.kv.value(PERMISSION_ERROR_KEY) as Record<string, unknown>;
		expect(stored).toMatchObject({ permission: "Checkout Sessions: Write", operation: "checkout session creation" });
		expect(JSON.stringify(stored)).not.toContain("rk_test");

		const settings = await adminSettingsHandler(harness.withInput({ action: "get" }));
		expect(settings.permissionError?.message).toBe(
			"Your restricted key is missing Checkout Sessions: Write (needed for checkout session creation).",
		);
	});

	it("does not record permission errors for secret keys", async () => {
		const harness = createHarness({
			input: {},
			fetch: stripeFetch({ "GET /products": () => forbidden("rak_product_read") }),
		});
		await harness.settings.put("stripeSecretKey", "sk_test_abcdefghijklmnop");
		await harness.stores.restrictions.put("posts:1", { collectionSlug: "posts", contentId: "1", productIds: ["prod_1"], updatedAt: "" });
		const { productsHandler } = await import("../src/handlers/products.js");
		await expect(productsHandler(harness.ctx)).rejects.toMatchObject({ code: "STRIPE_ERROR" });
		expect(harness.kv.value(PERMISSION_ERROR_KEY)).toBeUndefined();
	});
});

describe("key health", () => {
	const unauthorized = () => new Response(JSON.stringify({ error: { message: "Invalid API Key provided" } }), { status: 401 });

	it("asks for a new restricted key, not a reconnect, when Stripe rejects an rk_ key", async () => {
		const harness = createHarness({ fetch: stripeFetch({ "GET /account": unauthorized }) });
		await harness.settings.put("stripeSecretKey", RK);
		expect(await adminKeyHealthHandler(harness.ctx)).toMatchObject({
			ok: false,
			needsReconnect: false,
			needsNewKey: true,
			keyType: "restricted",
			message: expect.stringContaining("Update your restricted key"),
		});
	});

	it("keeps the reconnect prompt for Connect keys", async () => {
		const harness = createHarness({ fetch: stripeFetch({ "GET /account": unauthorized }) });
		await saveStripeKey(harness.ctx, {
			secretKey: "sk_test_connectedtoken123",
			keySource: "connect",
			environment: "sandbox",
			accountId: "acct_1",
			publishableKey: null,
			connectHashed: true,
		});
		expect(await adminKeyHealthHandler(harness.ctx)).toMatchObject({ needsReconnect: true, needsNewKey: false });
		expect(rejectedKeyHealth("manual", "secret")).toMatchObject({ needsNewKey: true, message: expect.stringContaining("Update your secret key") });
	});

	it("surfaces a recorded permission error for the current key", async () => {
		const harness = createHarness({ fetch: stripeFetch({ "GET /account": () => forbidden("rak_connected_account_read") }) });
		await harness.settings.put("stripeSecretKey", RK);
		const { sha256Hex } = await import("../src/lib/crypto.js");
		await harness.kv.set(PERMISSION_ERROR_KEY, { keyHash: await sha256Hex(RK), permission: "Invoices: Read", operation: "access check", at: "" });
		expect(await adminKeyHealthHandler(harness.ctx)).toMatchObject({
			ok: false,
			needsNewKey: false,
			permissionError: "Your restricted key is missing Invoices: Read (needed for access check).",
		});
	});
});

describe("no platform fee", () => {
	it("never sends application fee parameters when creating Checkout", async () => {
		const calls: Parameters<typeof stripeFetch>[1] = [];
		const harness = createHarness({
			input: { email: "buyer@example.test", price_id: "price_1", return_path: "/post" },
			fetch: stripeFetch(
				{
					"GET /prices/price_1": () => ({ id: "price_1", active: true, type: "recurring", product: { id: "prod_1", active: true } }),
					"POST /checkout/sessions": () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }),
				},
				calls,
			),
		});
		await harness.settings.put("stripeSecretKey", RK);
		await harness.stores.restrictions.put("posts:1", { collectionSlug: "posts", contentId: "1", productIds: ["prod_1"], updatedAt: "" });
		await checkoutHandler(harness.ctx);
		const body = calls.find((call) => call.path === "/checkout/sessions")!.body;
		expect([...body.keys()].filter((key) => key.includes("application_fee"))).toEqual([]);
	});
});
