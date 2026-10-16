// Fixed-window counters in plugin storage, updated with compare-and-set so
// concurrent requests cannot both take the last slot.

import { type Ctx, type RCtx, store } from "./context.js";
import { sha256Hex } from "./crypto.js";

export interface RateLimitRule {
	max: number;
	windowMs: number;
}

interface Bucket {
	count: number;
	windowStart: number;
	expiresAt: string;
}

const MAX_ATTEMPTS = 4;

/** Count one hit. Returns false when the caller is over the limit (or on persistent contention). */
export async function hitRateLimit(
	ctx: Ctx,
	scope: string,
	identifier: string,
	rule: RateLimitRule,
	now = Date.now(),
): Promise<boolean> {
	const buckets = store<Bucket>(ctx, "rateLimits");
	const key = `${scope}:${await sha256Hex(identifier)}`;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const current = await buckets.getVersioned(key);
		let next: Bucket;
		if (!current || now - current.value.windowStart >= rule.windowMs) {
			next = { count: 1, windowStart: now, expiresAt: new Date(now + rule.windowMs).toISOString() };
		} else if (current.value.count >= rule.max) {
			return false;
		} else {
			next = { ...current.value, count: current.value.count + 1 };
		}
		const result = await buckets.compareAndSet(key, current?.revision ?? null, next);
		if (result.applied) return true;
	}
	return false;
}

/**
 * Apply per-email and per-IP limits. The IP limit is skipped when EmDash cannot
 * determine the client IP (off Cloudflare without trustedProxyHeaders).
 */
export async function checkLimits(
	ctx: RCtx,
	scope: string,
	limits: { email?: { value: string; rule: RateLimitRule }; ip?: RateLimitRule },
): Promise<boolean> {
	const ip = ctx.requestMeta?.ip;
	if (limits.ip && ip && !(await hitRateLimit(ctx, `${scope}:ip`, ip, limits.ip))) return false;
	if (limits.email && !(await hitRateLimit(ctx, `${scope}:email`, limits.email.value, limits.email.rule))) {
		return false;
	}
	return true;
}

export const WINDOW_15_MIN = 15 * 60 * 1000;
