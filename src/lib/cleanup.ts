// Opportunistic removal of expired rows from the plugin's own collections.

import { type CollectionName, type Ctx, store } from "./context.js";

const EXPIRING: CollectionName[] = [
	"loginTokens",
	"sessions",
	"consumedCheckouts",
	"rateLimits",
	"accessCache",
];

export async function purgeExpired(ctx: Ctx, now = Date.now()): Promise<number> {
	const cutoff = new Date(now).toISOString();
	let removed = 0;
	for (const name of EXPIRING) {
		const collection = store<{ expiresAt: string }>(ctx, name);
		const page = await collection.query({ where: { expiresAt: { lt: cutoff } }, limit: 100 });
		if (page.items.length > 0) {
			removed += await collection.deleteMany(page.items.map((item) => item.id));
		}
	}
	return removed;
}

/** Run purgeExpired on roughly one call in `oneIn`, never failing the request. */
export async function maybePurgeExpired(ctx: Ctx, oneIn = 25): Promise<void> {
	if (Math.random() * oneIn >= 1) return;
	try {
		await purgeExpired(ctx);
	} catch (error) {
		ctx.log.warn("Expired-row cleanup failed", { error: String(error) });
	}
}
