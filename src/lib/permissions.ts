// Restricted-key ("rk_") support: the permission checklist the plugin's Stripe calls
// need, side-effect-free probes for the readable ones, and parsing of Stripe's 403
// permission errors into "Resource: Access" labels admins can act on.

import { getStripeConfig, PERMISSION_ERROR_KEY } from "./config.js";
import type { Ctx } from "./context.js";
import { type Access, REQUIRED_PERMISSIONS, type RequiredPermission } from "./permission-list.js";
import { StripeApiError, type StripeClient } from "./stripe.js";

export { type Access, REQUIRED_PERMISSIONS, type RequiredPermission };

const LABELS: Record<string, string> = Object.fromEntries(REQUIRED_PERMISSIONS.map((p) => [p.resource, p.label]));

export function permissionLabel(resource: string, access: Access): string {
	const name =
		LABELS[resource] ??
		resource
			.split("_")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");
	return `${name}: ${access === "write" ? "Write" : "Read"}`;
}

export interface ParsedPermission {
	resource: string;
	access: Access;
	label: string;
}

// Stripe names the missing permission in the message, e.g.
// "Enabling Charges and Refunds Read ('charge_read') permissions on this key would allow this request to continue."
const ENABLING_IN_MESSAGE = /Enabling (.+?) (Read|Write) \(['"`]([a-z][a-z0-9_]*?)_(read|write)['"`]\)/;
// Older wording: "Having the 'rak_checkout_session_write' permission would allow this request to continue."
const PERMISSION_IN_MESSAGE = /['"`]?(?:rak_)?([a-z][a-z0-9_]*?)_(read|write)['"`]?\)?\s+permission/;

/** The permission a Stripe 403 says is missing, or null for any other error. */
export function parsePermissionError(error: unknown): ParsedPermission | null {
	if (!(error instanceof StripeApiError) || error.status !== 403) return null;
	const enabling = ENABLING_IN_MESSAGE.exec(error.message);
	if (enabling) {
		const resource = enabling[3]!;
		const access = enabling[4] as Access;
		const label = LABELS[resource] ? permissionLabel(resource, access) : `${enabling[1]}: ${enabling[2]}`;
		return { resource, access, label };
	}
	const match = PERMISSION_IN_MESSAGE.exec(error.message);
	if (!match) return null;
	const resource = match[1]!;
	const access = match[2] as Access;
	return { resource, access, label: permissionLabel(resource, access) };
}

export function isPermissionError(error: unknown): boolean {
	return error instanceof StripeApiError && error.status === 403;
}

// ─── Probes ──────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "missing" | "unverified" | "error";

export interface ProbeResult {
	label: string;
	resource: string;
	access: Access;
	optional: boolean;
	status: ProbeStatus;
	message: string;
}

export type ProbeOutcome = { ok: true } | { ok: false; error: unknown };

/** Map one probe's outcome to what the settings page shows. */
export function mapProbeResult(permission: RequiredPermission, outcome: ProbeOutcome): ProbeResult {
	const base = {
		label: permissionLabel(permission.resource, permission.access),
		resource: permission.resource,
		access: permission.access,
		optional: Boolean(permission.optional),
	};
	if (outcome.ok) {
		return permission.access === "write"
			? { ...base, status: "unverified", message: "Read access confirmed. Write access is not verifiable until first use." }
			: { ...base, status: "ok", message: "Granted." };
	}
	if (isPermissionError(outcome.error)) {
		const parsed = parsePermissionError(outcome.error);
		const missing = parsed?.label ?? permissionLabel(permission.resource, "read");
		return {
			...base,
			status: "missing",
			message: permission.optional
				? `Not granted (${missing}). Optional: the account ID is not shown.`
				: `Missing. Stripe reports the key needs ${missing}.`,
		};
	}
	return { ...base, status: "error", message: "Stripe could not be reached to check this permission." };
}

export interface PermissionReport {
	keyType: "secret" | "restricted";
	invalidKey: boolean;
	ok: boolean;
	checkedAt: string;
	results: ProbeResult[];
}

/** Probe every permission with GET calls (limit=1); never creates or changes anything. */
export async function checkKeyPermissions(stripe: StripeClient, key: string, now = new Date()): Promise<PermissionReport> {
	const keyType = key.startsWith("rk_") ? "restricted" : "secret";
	const results: ProbeResult[] = [];
	let invalidKey = false;
	for (const permission of REQUIRED_PERMISSIONS) {
		let outcome: ProbeOutcome;
		try {
			await stripe.probe(permission.probePath);
			outcome = { ok: true };
		} catch (error) {
			if (error instanceof StripeApiError && error.isAuthError) {
				invalidKey = true;
				break;
			}
			outcome = { ok: false, error };
		}
		results.push(mapProbeResult(permission, outcome));
	}
	return {
		keyType,
		invalidKey,
		ok: !invalidKey && results.every((r) => r.optional || r.status === "ok" || r.status === "unverified"),
		checkedAt: now.toISOString(),
		results: invalidKey ? [] : results,
	};
}

// ─── Last runtime permission error ───────────────────────────────

export { PERMISSION_ERROR_KEY };

export interface LastPermissionError {
	keyHash: string;
	/** "Checkout Sessions: Write", or null when Stripe did not name the permission. */
	permission: string | null;
	operation: string;
	at: string;
}

/** Record a 403 from a restricted key so the settings page can name the missing permission. */
export async function notePermissionError(ctx: Ctx, operation: string, error: unknown): Promise<void> {
	if (!isPermissionError(error)) return;
	try {
		const config = await getStripeConfig(ctx);
		if (!config || !config.secretKey.startsWith("rk_")) return;
		const permission = parsePermissionError(error)?.label ?? null;
		ctx.log.warn("Stripe restricted key is missing a permission", { operation, permission });
		await ctx.kv.set(PERMISSION_ERROR_KEY, {
			keyHash: config.keyHash,
			permission,
			operation,
			at: new Date().toISOString(),
		} satisfies LastPermissionError);
	} catch (recordError) {
		ctx.log.warn("Could not record the Stripe permission error", { error: String(recordError) });
	}
}

/** The recorded permission error for the current key, with an admin-facing message. */
export async function lastPermissionError(ctx: Ctx, keyHash: string): Promise<(LastPermissionError & { message: string }) | null> {
	const stored = await ctx.kv.get<LastPermissionError>(PERMISSION_ERROR_KEY);
	if (!stored || stored.keyHash !== keyHash) return null;
	return { ...stored, message: permissionErrorMessage(stored) };
}

export function permissionErrorMessage(error: Pick<LastPermissionError, "permission" | "operation">): string {
	return error.permission
		? `Your restricted key is missing ${error.permission} (needed for ${error.operation}).`
		: `Stripe refused your restricted key permission for ${error.operation}. Compare the key with the permission checklist.`;
}

export async function clearPermissionError(ctx: Ctx): Promise<void> {
	await ctx.kv.delete(PERMISSION_ERROR_KEY);
}
