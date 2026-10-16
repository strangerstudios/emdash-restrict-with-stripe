// GET|POST products: products that restrict at least one entry, for the paywall picker.

import { requireStripe } from "../lib/config.js";
import type { RCtx } from "../lib/context.js";
import { getActiveProducts, type ProductSummary } from "../lib/products.js";
import { referencedProductIds } from "../lib/restrictions.js";
import { stripeCall } from "./util.js";

export async function productsHandler(ctx: RCtx): Promise<{ products: ProductSummary[] }> {
	const { config, stripe } = await requireStripe(ctx);
	const referenced = await referencedProductIds(ctx);
	if (referenced.size === 0) return { products: [] };
	const products = await stripeCall(ctx, "product listing", () => getActiveProducts(ctx, stripe, config.keyHash));
	return {
		products: products
			.filter((product) => referenced.has(product.id) && product.priceId)
			.map(({ id, name, description, priceId, price }) => ({ id, name, description, priceId, price })),
	};
}
