// Magic-link tokens and member sessions. Only sha256(token) is ever stored, so a
// database read does not yield a usable token.

import { type Ctx, store } from "./context.js";
import { isTokenShape, randomToken, sha256Hex } from "./crypto.js";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface LoginTokenRecord {
	email: string;
	/** Spellings to look up in Stripe, whose email filter is case-sensitive. */
	lookupEmails?: string[];
	returnPath: string;
	expiresAt: string;
}

/**
 * Who a session speaks for. Magic-link sessions prove control of the email and
 * cover every Stripe customer with it. Checkout sessions prove only that the
 * holder paid, so they are scoped to the one customer that Checkout created.
 */
export interface SessionIdentity {
	email: string;
	customerId: string | null;
	lookupEmails: string[];
}

export interface SessionRecord {
	email: string;
	customerId?: string | null;
	lookupEmails?: string[];
	createdAt: string;
	expiresAt: string;
}

export async function createLoginToken(
	ctx: Ctx,
	email: string,
	returnPath: string,
	now = Date.now(),
	lookupEmails: string[] = [email],
): Promise<string> {
	const token = randomToken();
	await store<LoginTokenRecord>(ctx, "loginTokens").put(await sha256Hex(token), {
		email,
		lookupEmails,
		returnPath,
		expiresAt: new Date(now + LOGIN_TOKEN_TTL_MS).toISOString(),
	});
	return token;
}

/**
 * Single-use consume. The row is removed with compareAndDelete against the revision
 * we read, so when two requests race on one token exactly one delete applies and
 * only that request gets the record. Expiry is checked after the delete so expired
 * tokens are cleaned up by the attempt.
 */
export async function consumeLoginToken(
	ctx: Ctx,
	token: unknown,
	now = Date.now(),
): Promise<LoginTokenRecord | null> {
	if (!isTokenShape(token)) return null;
	const tokens = store<LoginTokenRecord>(ctx, "loginTokens");
	const key = await sha256Hex(token);
	const current = await tokens.getVersioned(key);
	if (!current) return null;
	const { applied } = await tokens.compareAndDelete(key, current.revision);
	if (!applied) return null;
	if (Date.parse(current.value.expiresAt) <= now) return null;
	return current.value;
}

export async function createSession(
	ctx: Ctx,
	email: string,
	now = Date.now(),
	scope: { customerId?: string; lookupEmails?: string[] } = {},
): Promise<{ token: string; expiresAt: string }> {
	const token = randomToken();
	const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
	await store<SessionRecord>(ctx, "sessions").put(await sha256Hex(token), {
		email,
		customerId: scope.customerId ?? null,
		lookupEmails: scope.lookupEmails ?? [email],
		createdAt: new Date(now).toISOString(),
		expiresAt,
	});
	return { token, expiresAt };
}

export async function getSessionEmail(ctx: Ctx, token: unknown, now = Date.now()): Promise<string | null> {
	return (await getSession(ctx, token, now))?.email ?? null;
}

export async function getSession(
	ctx: Ctx,
	token: unknown,
	now = Date.now(),
): Promise<SessionIdentity | null> {
	if (!isTokenShape(token)) return null;
	const sessions = store<SessionRecord>(ctx, "sessions");
	const key = await sha256Hex(token);
	const record = await sessions.get(key);
	if (!record) return null;
	if (Date.parse(record.expiresAt) <= now) {
		await sessions.delete(key);
		return null;
	}
	return {
		email: record.email,
		customerId: record.customerId ?? null,
		lookupEmails: record.lookupEmails?.length ? record.lookupEmails : [record.email],
	};
}

export async function deleteSession(ctx: Ctx, token: unknown): Promise<void> {
	if (!isTokenShape(token)) return;
	await store<SessionRecord>(ctx, "sessions").delete(await sha256Hex(token));
}
