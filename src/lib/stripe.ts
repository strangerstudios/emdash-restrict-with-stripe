// Fetch-based Stripe client. Mirrors the calls the WordPress plugin makes and pins
// the same API version so response shapes stay stable across connected accounts.

export const STRIPE_API_VERSION = "2022-11-15";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type Params = Record<string, string | undefined>;

export class StripeApiError extends Error {
	override readonly name = "StripeApiError";
	constructor(
		readonly status: number,
		readonly type: string | undefined,
		readonly stripeCode: string | undefined,
		message: string,
	) {
		super(message);
	}

	/** True when Stripe rejected the key itself (revoked or deauthorized). */
	get isAuthError(): boolean {
		return this.status === 401;
	}
}

export interface StripePrice {
	id: string;
	active: boolean;
	currency: string;
	unit_amount: number | null;
	custom_unit_amount?: { minimum: number | null; maximum: number | null; preset: number | null } | null;
	type: "one_time" | "recurring";
	recurring: { interval: string; interval_count: number } | null;
	product: string | StripeProduct;
}

export interface StripeProduct {
	id: string;
	name: string;
	description: string | null;
	active: boolean;
	default_price: string | StripePrice | null;
}

export interface StripeCustomer {
	id: string;
	email: string | null;
	deleted?: boolean;
}

export interface StripeCheckoutSession {
	id: string;
	object: "checkout.session";
	url: string | null;
	status: "open" | "complete" | "expired" | null;
	payment_status: "paid" | "unpaid" | "no_payment_required";
	created: number;
	metadata: Record<string, string> | null;
	customer: string | StripeCustomer | null;
	customer_details: { email: string | null } | null;
}

interface StripeList<T> {
	data: T[];
	has_more: boolean;
}

interface LineLike {
	price?: { product?: string | { id?: string } } | null;
}

function productIdOf(line: LineLike): string | undefined {
	const product = line.price?.product;
	return typeof product === "string" ? product : product?.id;
}

export class StripeClient {
	constructor(
		private readonly secretKey: string,
		private readonly fetchFn: FetchFn,
	) {}

	/** Follow `has_more` with `starting_after`, up to `maxPages` pages of 100. */
	private async listAll<T extends { id?: string }>(path: string, params: Params, maxPages = 10): Promise<T[]> {
		const items: T[] = [];
		let startingAfter: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const list = await this.request<StripeList<T>>("GET", path, { ...params, limit: "100", starting_after: startingAfter });
			items.push(...list.data);
			const last = list.data[list.data.length - 1]?.id;
			if (!list.has_more || !last) break;
			startingAfter = last;
		}
		return items;
	}

	private async request<T>(method: "GET" | "POST", path: string, params: Params = {}): Promise<T> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) query.append(key, value);
		}
		const encoded = query.toString();
		const url = `https://api.stripe.com/v1${path}${method === "GET" && encoded ? `?${encoded}` : ""}`;
		const res = await this.fetchFn(url, {
			method,
			headers: {
				Authorization: `Bearer ${this.secretKey}`,
				"Content-Type": "application/x-www-form-urlencoded",
				"Stripe-Version": STRIPE_API_VERSION,
			},
			body: method === "POST" ? encoded : undefined,
		});
		const data = (await res.json().catch(() => ({}))) as {
			error?: { message?: string; type?: string; code?: string };
		};
		if (!res.ok) {
			throw new StripeApiError(
				res.status,
				data.error?.type,
				data.error?.code,
				data.error?.message ?? `Stripe request failed with status ${res.status}`,
			);
		}
		return data as T;
	}

	/** A read-only GET used to check a restricted key's access (limit=1 on list endpoints). */
	async probe(path: string): Promise<void> {
		await this.request("GET", path, path === "/account" ? {} : { limit: "1" });
	}

	getAccount(): Promise<{ id: string; email?: string | null; settings?: unknown }> {
		return this.request("GET", "/account");
	}

	/** All active products with their default price expanded (paginates up to 1,000). */
	async listActiveProducts(): Promise<StripeProduct[]> {
		const products: StripeProduct[] = [];
		let startingAfter: string | undefined;
		for (let page = 0; page < 10; page++) {
			const list = await this.request<StripeList<StripeProduct>>("GET", "/products", {
				active: "true",
				limit: "100",
				"expand[]": "data.default_price",
				starting_after: startingAfter,
			});
			products.push(...list.data);
			if (!list.has_more || list.data.length === 0) break;
			startingAfter = list.data[list.data.length - 1]?.id;
		}
		return products;
	}

	getPriceWithProduct(priceId: string): Promise<StripePrice> {
		return this.request("GET", `/prices/${encodeURIComponent(priceId)}`, { "expand[]": "product" });
	}

	/** Customers whose email matches exactly (Stripe's filter is case-sensitive). */
	async listCustomersByEmail(email: string): Promise<StripeCustomer[]> {
		const list = await this.request<StripeList<StripeCustomer>>("GET", "/customers", {
			email,
			limit: "100",
		});
		return list.data;
	}

	/**
	 * Customers a session may act for: only its own customer for Checkout sessions,
	 * otherwise every live customer matching one of the email spellings.
	 */
	async customersFor(identity: { customerId: string | null; lookupEmails: string[] }): Promise<string[]> {
		if (identity.customerId) return [identity.customerId];
		const ids = new Set<string>();
		for (const email of identity.lookupEmails) {
			for (const customer of await this.listCustomersByEmail(email)) {
				if (!customer.deleted) ids.add(customer.id);
			}
		}
		return [...ids];
	}

	createCheckoutSession(params: Params): Promise<StripeCheckoutSession> {
		return this.request("POST", "/checkout/sessions", params);
	}

	getCheckoutSession(id: string): Promise<StripeCheckoutSession> {
		return this.request("GET", `/checkout/sessions/${encodeURIComponent(id)}`, {
			"expand[]": "customer",
		});
	}

	/** The default portal configuration, creating one like the WordPress plugin does when none exists. */
	async ensurePortalConfiguration(): Promise<string> {
		const list = await this.request<StripeList<{ id: string; is_default: boolean }>>(
			"GET",
			"/billing_portal/configurations",
			{ active: "true", limit: "100" },
		);
		const existing = list.data.find((config) => config.is_default);
		if (existing) return existing.id;
		const created = await this.request<{ id: string }>("POST", "/billing_portal/configurations", {
			"business_profile[headline]": "Manage Your Subscriptions",
			"features[customer_update][enabled]": "true",
			"features[customer_update][allowed_updates][0]": "address",
			"features[customer_update][allowed_updates][1]": "phone",
			"features[customer_update][allowed_updates][2]": "tax_id",
			"features[invoice_history][enabled]": "true",
			"features[payment_method_update][enabled]": "true",
			"features[subscription_cancel][enabled]": "true",
		});
		return created.id;
	}

	createPortalSession(customerId: string, returnUrl: string, configuration: string) {
		return this.request<{ url: string }>("POST", "/billing_portal/sessions", {
			customer: customerId,
			return_url: returnUrl,
			configuration,
		});
	}

	/**
	 * Same rule as the WordPress plugin's customer_has_product(): an active or trialing
	 * subscription to one of the products, or a paid non-subscription invoice for one.
	 */
	async customerHasProduct(customerId: string, productIds: readonly string[]): Promise<boolean> {
		if (!customerId || productIds.length === 0) return false;
		const wanted = new Set(productIds);

		const subs = await this.listAll<{ id?: string; status: string; items?: { data?: LineLike[] } }>(
			"/subscriptions",
			{ customer: customerId, status: "all" },
		);
		for (const sub of subs) {
			if (sub.status !== "active" && sub.status !== "trialing") continue;
			for (const item of sub.items?.data ?? []) {
				const product = productIdOf(item);
				if (product && wanted.has(product)) return true;
			}
		}

		const invoices = await this.listAll<{
			id?: string;
			subscription?: string | null;
			metadata?: Record<string, string> | null;
			lines?: { data?: LineLike[] };
		}>("/invoices", { customer: customerId, status: "paid" });
		for (const invoice of invoices) {
			if (invoice.subscription) continue;
			if (invoice.metadata?.["rwstripe-ignore"]) continue;
			for (const line of invoice.lines?.data ?? []) {
				const product = productIdOf(line);
				if (product && wanted.has(product)) return true;
			}
		}
		return false;
	}
}
