import { describe, expect, it } from "vitest";

import { accessHandler } from "../src/handlers/access.js";
import { sendLinkHandler, verifyHandler } from "../src/handlers/auth.js";
import { createHarness, stripeFetch } from "./support/fake-ctx.js";

const KEY = "sk_test_abcdefghijklmnop";

async function harness(
	customers: string[],
	options: Parameters<typeof createHarness>[0] = {},
	ownedProduct = "prod_A",
) {
	const h = createHarness({
		siteName: `Tom's <Site>`,
		fetch: stripeFetch({
			"GET /customers": (_body, url) => ({
				data: customers.includes(url.searchParams.get("email") ?? "") ? [{ id: "cus_1", email: url.searchParams.get("email") }] : [],
				has_more: false,
			}),
			"GET /subscriptions": () => ({
				data: [{ status: "active", items: { data: [{ price: { product: ownedProduct } }] } }],
				has_more: false,
			}),
			"GET /invoices": () => ({ data: [], has_more: false }),
		}),
		...options,
	});
	await h.settings.put("stripeSecretKey", KEY);
	await h.stores.restrictions.put("posts:01ABC", { collectionSlug: "posts", contentId: "01ABC", productIds: ["prod_A"], updatedAt: "" });
	return h;
}

const GENERIC = { ok: true, message: "If that email has a purchase on this site, a login link is on its way." };

describe("auth/send-link", () => {
	it("emails a single-use link to Stripe customers and escapes the site name", async () => {
		const h = await harness(["buyer@example.test"]);
		const result = await sendLinkHandler(h.withInput({ email: "Buyer@Example.test", return_path: "/posts/a?rwstripe_login=old" }));
		expect(result).toEqual(GENERIC);
		expect(h.sentEmail).toHaveLength(1);
		const mail = h.sentEmail[0]!;
		expect(mail.to).toBe("buyer@example.test");
		const link = mail.text.match(/https:\/\/\S+/)![0];
		const url = new URL(link);
		expect(url.origin + url.pathname).toBe("https://example.test/posts/a");
		const token = url.searchParams.get("rwstripe_login")!;
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(mail.html).toContain("Tom&#39;s &lt;Site&gt;");
		expect(mail.html).not.toContain("<Site>");

		const verified = await verifyHandler(h.withInput({ token }));
		expect(verified).toMatchObject({ email: "buyer@example.test", returnPath: "/posts/a" });
		await expect(verifyHandler(h.withInput({ token }))).rejects.toMatchObject({ code: "INVALID_LOGIN_LINK" });
	});

	it("does not mail customers who hold no restricting product", async () => {
		const h = await harness(["buyer@example.test"], {}, "prod_UNRELATED");
		expect(await sendLinkHandler(h.withInput({ email: "buyer@example.test", return_path: "/" }))).toEqual(GENERIC);
		expect(h.sentEmail).toHaveLength(0);
	});

	it("finds Stripe customers saved with mixed-case emails", async () => {
		const h = await harness(["Bob@Example.test"]);
		await sendLinkHandler(h.withInput({ email: "Bob@Example.test", return_path: "/" }));
		expect(h.sentEmail).toHaveLength(1);
		const token = new URL(h.sentEmail[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("rwstripe_login");
		const { session } = await verifyHandler(h.withInput({ token }));
		expect(await accessHandler(h.withInput({ collection: "posts", id: "01ABC", session }))).toMatchObject({ hasAccess: true, email: "bob@example.test" });
	});

	it("hides email delivery failures behind the generic answer", async () => {
		const h = await harness(["buyer@example.test"]);
		const failing = { send: async () => Promise.reject(new Error("smtp down")) };
		const ctx = { ...h.withInput({ email: "buyer@example.test", return_path: "/" }), email: failing };
		expect(await sendLinkHandler(ctx as typeof h.ctx)).toEqual(GENERIC);
		expect(h.logs.some((entry) => entry.level === "error")).toBe(true);
	});

	it("answers identically for non-customers and sends nothing", async () => {
		const h = await harness([]);
		expect(await sendLinkHandler(h.withInput({ email: "nobody@example.test", return_path: "/" }))).toEqual(GENERIC);
		expect(h.sentEmail).toHaveLength(0);
	});

	it("rate limits per email without changing the response", async () => {
		const h = await harness(["buyer@example.test"]);
		for (let i = 0; i < 5; i++) {
			expect(await sendLinkHandler(h.withInput({ email: "buyer@example.test", return_path: "/" }))).toEqual(GENERIC);
		}
		expect(h.sentEmail).toHaveLength(3);
	});

	it("rate limits per IP across emails", async () => {
		const emails = Array.from({ length: 12 }, (_, i) => `b${i}@example.test`);
		const h = await harness(emails);
		for (const email of emails) await sendLinkHandler(h.withInput({ email, return_path: "/" }));
		expect(h.sentEmail).toHaveLength(10);
	});

	it("reports a missing email provider", async () => {
		const h = await harness(["buyer@example.test"], { email: false });
		await expect(sendLinkHandler(h.withInput({ email: "buyer@example.test", return_path: "/" }))).rejects.toMatchObject({
			code: "EMAIL_NOT_CONFIGURED",
		});
	});

	it("never builds links from a missing site URL", async () => {
		const h = await harness(["buyer@example.test"], { siteUrl: "" });
		await expect(sendLinkHandler(h.withInput({ email: "buyer@example.test", return_path: "/" }))).rejects.toMatchObject({
			code: "SITE_URL_NOT_CONFIGURED",
		});
		expect(h.sentEmail).toHaveLength(0);
	});
});

describe("access", () => {
	it("is unrestricted when no restriction exists", async () => {
		const h = await harness([]);
		expect(await accessHandler(h.withInput({ collection: "posts", id: "OTHER" }))).toEqual({
			restricted: false,
			hasAccess: true,
			productIds: [],
		});
	});

	it("grants access to a session whose email holds the product", async () => {
		const h = await harness(["buyer@example.test"]);
		expect(await accessHandler(h.withInput({ collection: "posts", id: "01ABC" }))).toMatchObject({ restricted: true, hasAccess: false });

		await sendLinkHandler(h.withInput({ email: "buyer@example.test", return_path: "/" }));
		const token = new URL(h.sentEmail[0]!.text.match(/https:\/\/\S+/)![0]).searchParams.get("rwstripe_login");
		const { session } = await verifyHandler(h.withInput({ token }));
		expect(await accessHandler(h.withInput({ collection: "posts", id: "01ABC", session }))).toMatchObject({
			restricted: true,
			hasAccess: true,
			email: "buyer@example.test",
		});
	});
});
