// Product listing with a short KV cache and display formatting.

import { PRODUCTS_CACHE_KEY } from "./config.js";
import type { Ctx } from "./context.js";
import type { StripeClient, StripePrice, StripeProduct } from "./stripe.js";

const PRODUCTS_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ProductSummary {
	id: string;
	name: string;
	description: string | null;
	priceId: string | null;
	price: string | null;
}

interface CachedProducts {
	keyHash: string;
	fetchedAt: number;
	products: ProductSummary[];
}

function formatAmount(cents: number, currency: string, locale: string): string {
	try {
		const formatter = new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() });
		const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
		return formatter.format(cents / 10 ** digits);
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
	}
}

export function formatPrice(price: StripePrice, locale = "en"): string | null {
	if (price.unit_amount === null) {
		// Pay-what-you-want (customer chooses the amount in Checkout).
		if (!price.custom_unit_amount) return null;
		const min = price.custom_unit_amount.minimum;
		return min ? `Pay what you want (min ${formatAmount(min, price.currency, locale)})` : "Pay what you want";
	}
	const amount = formatAmount(price.unit_amount, price.currency, locale);
	if (price.type !== "recurring" || !price.recurring) return amount;
	const { interval, interval_count: count } = price.recurring;
	return count === 1 ? `${amount} / ${interval}` : `${amount} every ${count} ${interval}s`;
}

export function summarizeProduct(product: StripeProduct, locale = "en"): ProductSummary {
	const price = typeof product.default_price === "object" ? product.default_price : null;
	const usable = price?.active ? price : null;
	return {
		id: product.id,
		name: product.name,
		description: product.description,
		priceId: usable?.id ?? (typeof product.default_price === "string" ? product.default_price : null),
		price: usable ? formatPrice(usable, locale) : null,
	};
}

/** All active products. Served from a five-minute cache unless `fresh` is set. */
export async function getActiveProducts(
	ctx: Ctx,
	stripe: StripeClient,
	keyHash: string,
	options: { fresh?: boolean; now?: number } = {},
): Promise<ProductSummary[]> {
	const now = options.now ?? Date.now();
	if (!options.fresh) {
		const cached = await ctx.kv.get<CachedProducts>(PRODUCTS_CACHE_KEY);
		if (cached?.keyHash === keyHash && now - cached.fetchedAt < PRODUCTS_CACHE_TTL_MS) {
			return cached.products;
		}
	}
	const locale = ctx.site.locale || "en";
	const products = (await stripe.listActiveProducts()).map((product) =>
		summarizeProduct(product, locale),
	);
	await ctx.kv.set(PRODUCTS_CACHE_KEY, { keyHash, fetchedAt: now, products } satisfies CachedProducts);
	return products;
}
