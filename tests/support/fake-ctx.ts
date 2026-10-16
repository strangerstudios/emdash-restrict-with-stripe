// In-memory plugin context with the conditional-write semantics EmDash documents:
// every write changes the revision, compareAndSet(null) creates only when absent,
// compareAndDelete applies only for the current revision.

import type { RouteContext } from "emdash";

type Row = { value: unknown; revision: string };

let revisionCounter = 0;
const nextRevision = () => `r${++revisionCounter}`;
// Yield so concurrent callers interleave the way they would against a database.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function rangeMatch(value: unknown, filter: unknown): boolean {
	if (filter && typeof filter === "object" && "lt" in filter) {
		return typeof value === "string" && value < String((filter as { lt: unknown }).lt);
	}
	return value === filter;
}

export class FakeStore {
	rows = new Map<string, Row>();

	async get(id: string) {
		await tick();
		return this.rows.has(id) ? structuredClone(this.rows.get(id)!.value) : null;
	}
	async put(id: string, value: unknown) {
		await tick();
		this.rows.set(id, { value: structuredClone(value), revision: nextRevision() });
	}
	async set(id: string, value: unknown) {
		return this.put(id, value);
	}
	async delete(id: string) {
		await tick();
		return this.rows.delete(id);
	}
	async exists(id: string) {
		return this.rows.has(id);
	}
	async getVersioned(id: string) {
		await tick();
		const row = this.rows.get(id);
		return row ? { value: structuredClone(row.value), revision: row.revision } : null;
	}
	async compareAndSet(id: string, expected: string | null, value: unknown) {
		await tick();
		const row = this.rows.get(id);
		if (expected === null ? row !== undefined : row?.revision !== expected) return { applied: false as const };
		const revision = nextRevision();
		this.rows.set(id, { value: structuredClone(value), revision });
		return { applied: true as const, revision };
	}
	async compareAndDelete(id: string, expected: string) {
		await tick();
		const row = this.rows.get(id);
		if (!row || row.revision !== expected) return { applied: false };
		this.rows.delete(id);
		return { applied: true };
	}
	async query(options: { where?: Record<string, unknown>; limit?: number } = {}) {
		await tick();
		const items = [...this.rows.entries()]
			.filter(([, row]) =>
				Object.entries(options.where ?? {}).every(([field, filter]) =>
					rangeMatch((row.value as Record<string, unknown>)[field], filter),
				),
			)
			.slice(0, options.limit ?? 50)
			.map(([id, row]) => ({ id, data: structuredClone(row.value) }));
		return { items, hasMore: false };
	}
	async deleteMany(ids: string[]) {
		let count = 0;
		for (const id of ids) if (this.rows.delete(id)) count++;
		return count;
	}
	async list(prefix = "") {
		return [...this.rows.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([key, row]) => ({ key, value: structuredClone(row.value) }));
	}
	value(id: string) {
		return this.rows.get(id)?.value;
	}
}

export interface FakeOptions {
	input?: unknown;
	siteUrl?: string;
	siteName?: string;
	ip?: string | null;
	email?: boolean;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface FakeHarness {
	ctx: RouteContext;
	stores: Record<string, FakeStore>;
	kv: FakeStore;
	settings: FakeStore;
	sentEmail: Array<{ to: string; subject: string; text: string; html?: string }>;
	logs: Array<{ level: string; message: string }>;
	withInput(input: unknown): RouteContext;
}

export function createHarness(options: FakeOptions = {}): FakeHarness {
	const stores: Record<string, FakeStore> = {
		restrictions: new FakeStore(),
		loginTokens: new FakeStore(),
		sessions: new FakeStore(),
		consumedCheckouts: new FakeStore(),
		rateLimits: new FakeStore(),
		accessCache: new FakeStore(),
	};
	const kv = new FakeStore();
	const settings = new FakeStore();
	const sentEmail: FakeHarness["sentEmail"] = [];
	const logs: FakeHarness["logs"] = [];
	const log = (level: string) => (message: string) => void logs.push({ level, message });

	const base = {
		plugin: { id: "restrict-with-stripe", version: "0.2.0" },
		storage: stores,
		kv,
		settings,
		log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
		site: { name: options.siteName ?? "Test Site", url: options.siteUrl ?? "https://example.test", locale: "en" },
		url: (path: string) => `${options.siteUrl ?? "https://example.test"}${path}`,
		http: options.fetch ? { fetch: options.fetch } : undefined,
		email:
			options.email === false
				? undefined
				: {
						send: async (message: { to: string; subject: string; text: string; html?: string }) => {
							sentEmail.push(message);
						},
					},
		request: new Request("https://example.test/_emdash/api/plugins/restrict-with-stripe/x", { method: "POST" }),
		requestMeta: { ip: options.ip === undefined ? "203.0.113.5" : options.ip, userAgent: null, referer: null, geo: null },
	};

	const withInput = (input: unknown) => ({ ...base, input }) as unknown as RouteContext;
	return { ctx: withInput(options.input ?? {}), stores, kv, settings, sentEmail, logs, withInput };
}

/** A fetch double for api.stripe.com keyed by "METHOD /path". */
export function stripeFetch(
	routes: Record<string, (body: URLSearchParams, url: URL) => unknown | Promise<unknown>>,
	calls: Array<{ method: string; path: string; body: URLSearchParams; url: URL }> = [],
) {
	return async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		const method = init?.method ?? "GET";
		const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
		const path = url.pathname.replace(/^\/v1/, "");
		calls.push({ method, path, body, url });
		const handler = routes[`${method} ${path}`];
		if (!handler) {
			return new Response(JSON.stringify({ error: { message: `No route ${method} ${path}` } }), { status: 404 });
		}
		const result = await handler(body, url);
		if (result instanceof Response) return result;
		return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
	};
}
