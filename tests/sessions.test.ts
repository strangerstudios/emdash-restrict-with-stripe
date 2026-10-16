import { describe, expect, it } from "vitest";

import { isTokenShape, randomToken, sha256Hex } from "../src/lib/crypto.js";
import { hitRateLimit } from "../src/lib/ratelimit.js";
import {
	LOGIN_TOKEN_TTL_MS,
	SESSION_TTL_MS,
	consumeLoginToken,
	createLoginToken,
	createSession,
	deleteSession,
	getSessionEmail,
} from "../src/lib/sessions.js";
import { createHarness } from "./support/fake-ctx.js";

describe("tokens", () => {
	it("are 32 random bytes in base64url", () => {
		const a = randomToken();
		const b = randomToken();
		expect(isTokenShape(a)).toBe(true);
		expect(a).not.toBe(b);
		expect(Buffer.from(a, "base64url")).toHaveLength(32);
	});

	it("hash with SHA-256", async () => {
		expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});

describe("login tokens", () => {
	it("store only the hash of the token", async () => {
		const { ctx, stores } = createHarness();
		const token = await createLoginToken(ctx, "a@example.test", "/post");
		expect(stores.loginTokens.rows.has(token)).toBe(false);
		expect(stores.loginTokens.rows.has(await sha256Hex(token))).toBe(true);
		expect(JSON.stringify([...stores.loginTokens.rows])).not.toContain(token);
	});

	it("consume exactly once", async () => {
		const { ctx } = createHarness();
		const token = await createLoginToken(ctx, "a@example.test", "/post");
		expect(await consumeLoginToken(ctx, token)).toMatchObject({ email: "a@example.test", returnPath: "/post" });
		expect(await consumeLoginToken(ctx, token)).toBeNull();
	});

	it("let only one of two concurrent consumers win", async () => {
		const { ctx } = createHarness();
		const token = await createLoginToken(ctx, "a@example.test", "/post");
		const results = await Promise.all([consumeLoginToken(ctx, token), consumeLoginToken(ctx, token)]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	it("reject and remove expired tokens", async () => {
		const { ctx, stores } = createHarness();
		const now = Date.now();
		const token = await createLoginToken(ctx, "a@example.test", "/post", now);
		expect(await consumeLoginToken(ctx, token, now + LOGIN_TOKEN_TTL_MS + 1)).toBeNull();
		expect(stores.loginTokens.rows.size).toBe(0);
	});

	it("reject malformed tokens without touching storage", async () => {
		const { ctx } = createHarness();
		expect(await consumeLoginToken(ctx, "short")).toBeNull();
		expect(await consumeLoginToken(ctx, { token: "x" })).toBeNull();
	});
});

describe("sessions", () => {
	it("resolve to the email until they expire", async () => {
		const { ctx, stores } = createHarness();
		const now = Date.now();
		const { token } = await createSession(ctx, "a@example.test", now);
		expect(stores.sessions.rows.has(token)).toBe(false);
		expect(await getSessionEmail(ctx, token, now + 1000)).toBe("a@example.test");
		expect(await getSessionEmail(ctx, token, now + SESSION_TTL_MS + 1)).toBeNull();
		expect(stores.sessions.rows.size).toBe(0);
	});

	it("end on logout", async () => {
		const { ctx } = createHarness();
		const { token } = await createSession(ctx, "a@example.test");
		await deleteSession(ctx, token);
		expect(await getSessionEmail(ctx, token)).toBeNull();
	});
});

describe("rate limits", () => {
	it("allow max hits per window, then block until the window resets", async () => {
		const { ctx } = createHarness();
		const rule = { max: 3, windowMs: 1000 };
		const now = Date.now();
		const results = [];
		for (let i = 0; i < 4; i++) results.push(await hitRateLimit(ctx, "t", "a@example.test", rule, now));
		expect(results).toEqual([true, true, true, false]);
		expect(await hitRateLimit(ctx, "t", "a@example.test", rule, now + 1001)).toBe(true);
	});

	it("do not over-admit under concurrency", async () => {
		const { ctx } = createHarness();
		const rule = { max: 3, windowMs: 60_000 };
		const results = await Promise.all(Array.from({ length: 8 }, () => hitRateLimit(ctx, "t", "x", rule)));
		expect(results.filter(Boolean).length).toBeLessThanOrEqual(3);
	});
});
