// Content restrictions, keyed by `${collection}:${entryId}`.

import { type Ctx, store } from "./context.js";

export interface Restriction {
	collectionSlug: string;
	contentId: string;
	productIds: string[];
	updatedAt: string;
}

const MAX_PAGES = 50;

export function restrictionKey(collection: string, id: string): string {
	return `${collection}:${id}`;
}

export async function getRestrictedProductIds(
	ctx: Ctx,
	collection: string,
	id: string,
): Promise<string[]> {
	const restriction = await store<Restriction>(ctx, "restrictions").get(restrictionKey(collection, id));
	return [...new Set(restriction?.productIds ?? [])];
}

export async function listRestrictions(ctx: Ctx): Promise<Restriction[]> {
	const restrictions = store<Restriction>(ctx, "restrictions");
	const all: Restriction[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await restrictions.query({ limit: 100, cursor });
		all.push(...result.items.map((item) => item.data));
		if (!result.hasMore || !result.cursor) break;
		cursor = result.cursor;
	}
	return all;
}

/** Every product referenced by at least one restriction; only these are sold or listed publicly. */
export async function referencedProductIds(ctx: Ctx): Promise<Set<string>> {
	const ids = new Set<string>();
	for (const restriction of await listRestrictions(ctx)) {
		for (const id of restriction.productIds) ids.add(id);
	}
	return ids;
}
