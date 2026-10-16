// Trusted React admin: settings page, restrictions page, dashboard widget, and the
// "Restrict With Stripe" editor panel. All calls go through apiFetch(), which adds
// the X-EmDash-Request header that cookie-authenticated private routes require.

import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

import { REQUIRED_PERMISSIONS } from "./lib/permission-list.js";

const API = "/_emdash/api/plugins/restrict-with-stripe";
const STATE_PARAM = "rwstripe_state";

async function call<T>(route: string, payload: Record<string, unknown> = {}): Promise<T> {
	const response = await apiFetch(`${API}/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	return parseApiResponse<T>(response, "Request failed");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface Settings {
	configured: boolean;
	keySource: "connect" | "manual" | null;
	environment: "live" | "sandbox" | null;
	accountId: string | null;
	key: { type: "secret" | "restricted"; last4: string } | null;
	publishableKeySet: boolean;
	connectHashed: boolean;
	showExcerpts: boolean;
	siteUrl: string | null;
	emailConfigured: boolean;
	encryptionError: boolean;
	permissionError: { permission: string | null; operation: string; at: string; message: string } | null;
	permissionReport: PermissionReport | null;
}

interface KeyHealth {
	configured: boolean;
	ok: boolean;
	needsReconnect: boolean;
	needsNewKey: boolean;
	keyType?: "secret" | "restricted";
	message?: string;
	permissionError?: string | null;
	error?: string;
}

interface PermissionReport {
	keyType: "secret" | "restricted";
	invalidKey: boolean;
	ok: boolean;
	checkedAt: string;
	results: Array<{ label: string; optional: boolean; status: "ok" | "missing" | "unverified" | "error"; message: string }>;
}

interface Product {
	id: string;
	name: string;
	description: string | null;
	priceId: string | null;
	price: string | null;
}

interface RestrictionItem {
	collectionSlug: string;
	contentId: string;
	productIds: string[];
	title: string | null;
	slug: string | null;
}

// ─── Shared UI ───────────────────────────────────────────────────

const muted: React.CSSProperties = { opacity: 0.7, fontSize: 13 };
const buttonStyle: React.CSSProperties = {
	padding: "8px 16px",
	background: "#635bff",
	color: "#fff",
	border: "none",
	borderRadius: 6,
	cursor: "pointer",
	fontSize: 14,
	fontWeight: 500,
};
const secondaryButton: React.CSSProperties = {
	...buttonStyle,
	background: "transparent",
	color: "inherit",
	border: "1px solid currentColor",
	opacity: 0.85,
};
const linkButton: React.CSSProperties = {
	background: "none",
	border: "none",
	padding: 0,
	color: "#635bff",
	cursor: "pointer",
	textDecoration: "underline",
	font: "inherit",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section style={{ marginBottom: 28 }}>
			<h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{title}</h3>
			{children}
		</section>
	);
}

function Notice({ tone, children }: { tone: "info" | "warn" | "error" | "ok"; children: React.ReactNode }) {
	const colors = { info: "#635bff", warn: "#b45309", error: "#dc2626", ok: "#059669" };
	return (
		<div
			role={tone === "error" ? "alert" : "status"}
			style={{ borderLeft: `3px solid ${colors[tone]}`, padding: "8px 12px", margin: "8px 0", fontSize: 14 }}
		>
			{children}
		</div>
	);
}

// ─── Restricted key permissions ──────────────────────────────────

const cell: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid rgba(127,127,127,0.25)", textAlign: "left", verticalAlign: "top" };

function PermissionChecklist() {
	return (
		<table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%", margin: "8px 0" }}>
			<thead>
				<tr>
					<th style={cell}>Resource</th>
					<th style={cell}>Permission</th>
					<th style={cell}>Used for</th>
				</tr>
			</thead>
			<tbody>
				{REQUIRED_PERMISSIONS.map((permission) => (
					<tr key={permission.resource}>
						<td style={cell}>{permission.label}</td>
						<td style={cell}>
							<strong>{permission.access === "write" ? "Write" : "Read"}</strong>
							{permission.optional ? " (optional)" : ""}
						</td>
						<td style={cell}>{permission.usedFor}</td>
					</tr>
				))}
				<tr>
					<td style={cell}>Everything else</td>
					<td style={cell}>
						<strong>None</strong>
					</td>
					<td style={cell}>Not used by this plugin.</td>
				</tr>
			</tbody>
		</table>
	);
}

const statusText = { ok: "OK", missing: "Missing", unverified: "Checked on first use", error: "Unknown" } as const;
const statusColor = { ok: "#059669", missing: "#dc2626", unverified: "#b45309", error: "#b45309" } as const;

function PermissionResults({ report }: { report: PermissionReport }) {
	if (report.invalidKey) {
		return <Notice tone="error">Stripe rejected this key, so its permissions could not be checked. Update your restricted key.</Notice>;
	}
	return (
		<>
			<table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%", margin: "8px 0" }}>
				<tbody>
					{report.results.map((result) => (
						<tr key={result.label}>
							<td style={cell}>{result.label}</td>
							<td style={{ ...cell, color: statusColor[result.status], fontWeight: 600, whiteSpace: "nowrap" }}>
								{result.optional && result.status === "missing" ? "Not granted" : statusText[result.status]}
							</td>
							<td style={cell}>{result.message}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p style={muted}>Checked {new Date(report.checkedAt).toLocaleString()} with read-only requests.</p>
		</>
	);
}

// ─── Settings page ───────────────────────────────────────────────

function readConnectReturn(): { action: "complete-connect" | "complete-disconnect"; params: Record<string, string> } | null {
	const search = new URLSearchParams(window.location.search);
	if (!search.has(STATE_PARAM)) return null;
	const params: Record<string, string> = {};
	search.forEach((value, key) => {
		params[key] = value;
	});
	if (search.has("pmpro_stripe_connected")) return { action: "complete-connect", params };
	if (search.has("pmpro_stripe_disconnected")) return { action: "complete-disconnect", params };
	return null;
}

function SettingsPage() {
	const [settings, setSettings] = React.useState<Settings | null>(null);
	const [health, setHealth] = React.useState<KeyHealth | null>(null);
	const [message, setMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [sandbox, setSandbox] = React.useState(false);
	const [manualKey, setManualKey] = React.useState("");
	const [manualOpen, setManualOpen] = React.useState(false);

	const load = React.useCallback(async () => {
		try {
			setSettings(await call<Settings>("admin/settings", { action: "get" }));
			setHealth(await call<KeyHealth>("admin/key-health"));
		} catch (error) {
			setMessage({ tone: "error", text: errorText(error) });
		}
	}, []);

	React.useEffect(() => {
		const pending = readConnectReturn();
		if (!pending) {
			void load();
			return;
		}
		// Drop the returned keys and state from the address bar before anything else.
		window.history.replaceState(null, "", window.location.pathname);
		call<{ ok: boolean; message: string }>("admin/connect", { action: pending.action, params: pending.params })
			.then((result) => setMessage({ tone: result.ok ? "ok" : "error", text: result.message }))
			.catch((error) => setMessage({ tone: "error", text: errorText(error) }))
			.finally(() => void load());
	}, [load]);

	const startFlow = async (action: "start-connect" | "start-disconnect") => {
		setBusy(true);
		setMessage(null);
		try {
			const { url } = await call<{ url: string }>("admin/connect", {
				action,
				environment: sandbox ? "sandbox" : "live",
			});
			window.location.assign(url);
		} catch (error) {
			setMessage({ tone: "error", text: errorText(error) });
			setBusy(false);
		}
	};

	const save = async (payload: Record<string, unknown>, done: string) => {
		setBusy(true);
		setMessage(null);
		try {
			const next = await call<Settings>("admin/settings", { action: "save", ...payload });
			setSettings(next);
			setHealth(await call<KeyHealth>("admin/key-health"));
			const report = payload.secretKey ? next.permissionReport : null;
			setMessage(
				report && !report.ok
					? { tone: "error", text: "Key saved, but it is missing permissions. See the check results below." }
					: { tone: "ok", text: done },
			);
			setManualKey("");
			setManualOpen(false);
		} catch (error) {
			setMessage({ tone: "error", text: errorText(error) });
		}
		setBusy(false);
	};

	const checkPermissions = async () => {
		setBusy(true);
		setMessage(null);
		try {
			const result = await call<{ report: PermissionReport; settings: Settings }>("admin/permissions");
			setSettings(result.settings);
			setHealth(await call<KeyHealth>("admin/key-health"));
			setMessage(
				result.report.ok
					? { tone: "ok", text: "The key has every permission that can be checked without side effects." }
					: { tone: "error", text: "The key is missing permissions. See the results below." },
			);
		} catch (error) {
			setMessage({ tone: "error", text: errorText(error) });
		}
		setBusy(false);
	};

	const removeKey = async (confirmLocalOnly: boolean) => {
		const prompt = confirmLocalOnly
			? "Remove this Stripe key from this site only? The Connect authorization stays in place at Stripe."
			: "Remove the Stripe key from this site?";
		if (!window.confirm(prompt)) return;
		setBusy(true);
		try {
			setSettings(await call<Settings>("admin/settings", { action: "remove-key", confirmLocalOnly }));
			setHealth(null);
			setMessage({ tone: "ok", text: "Stripe key removed." });
		} catch (error) {
			setMessage({ tone: "error", text: errorText(error) });
		}
		setBusy(false);
	};

	if (!settings) {
		return message ? <Notice tone="error">{message.text}</Notice> : <p>Loading…</p>;
	}

	const envLabel = settings.environment === "sandbox" ? " (Sandbox)" : "";
	const connectButtons = (
		<>
			<label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, margin: "8px 0 12px" }}>
				<input type="checkbox" checked={sandbox} onChange={(event) => setSandbox(event.target.checked)} />
				Connect a Stripe sandbox (test mode)
			</label>
			<button type="button" style={buttonStyle} disabled={busy || !settings.siteUrl} onClick={() => void startFlow("start-connect")}>
				{settings.configured ? "Reconnect to Stripe" : "Connect to Stripe"}
				{sandbox ? " (Sandbox)" : ""}
			</button>
		</>
	);

	return (
		<div style={{ maxWidth: 680, padding: 16 }}>
			<h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Restrict With Stripe</h2>
			{message && <Notice tone={message.tone}>{message.text}</Notice>}
			{!settings.siteUrl && (
				<Notice tone="warn">
					The site URL is not configured, so Stripe Connect, checkout, and login links are disabled. Set
					<code> siteUrl</code> in the emdash() integration, the <code>EMDASH_SITE_URL</code> environment variable,
					or the Site URL under Settings &gt; General.
				</Notice>
			)}
			{settings.encryptionError && (
				<Notice tone="error">The stored Stripe key cannot be decrypted. Check EMDASH_ENCRYPTION_KEY.</Notice>
			)}
			{!settings.emailConfigured && (
				<Notice tone="warn">
					No email provider is configured, so members cannot request login links. Buyers are still logged in
					automatically when they return from Stripe Checkout.
				</Notice>
			)}

			<Section title={`1. Connect to Stripe${settings.configured ? ` — connected${envLabel}` : ""}`}>
				{settings.configured ? (
					<>
						<p style={{ fontSize: 14 }}>
							{settings.keySource === "connect" ? "Connected through Stripe Connect" : "Using a manually entered key"}
							{settings.accountId ? (
								<>
									{" "}to account <strong>{settings.accountId}</strong>
								</>
							) : null}
							{settings.key ? ` (${settings.key.type} key ending ${settings.key.last4})` : ""}.
						</p>
						{health?.needsReconnect && (
							<Notice tone="error">
								Stripe no longer accepts this key. It may have been revoked or the account disconnected from the
								Stripe dashboard. Reconnect to Stripe to restore checkout and access checks.
							</Notice>
						)}
						{health?.needsNewKey && (
							<Notice tone="error">
								Stripe no longer accepts this {health.keyType === "restricted" ? "restricted" : "secret"} key. It may have been
								revoked, rolled, or deleted in the Stripe dashboard.{" "}
								<button type="button" style={linkButton} onClick={() => setManualOpen(true)}>
									{health.keyType === "restricted" ? "Update your restricted key" : "Update your key"}
								</button>
							</Notice>
						)}
						{settings.permissionError && <Notice tone="error">{settings.permissionError.message}</Notice>}
						{settings.key?.type === "restricted" && (
							<div style={{ marginTop: 12 }}>
								<button type="button" style={secondaryButton} disabled={busy} onClick={() => void checkPermissions()}>
									Check key permissions
								</button>
								{settings.permissionReport && <PermissionResults report={settings.permissionReport} />}
							</div>
						)}
						{health?.error && <Notice tone="warn">Could not reach Stripe to check the key.</Notice>}
						{health?.needsReconnect && connectButtons}
						<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
							{settings.keySource === "connect" && (
								<button type="button" style={secondaryButton} disabled={busy || !settings.siteUrl} onClick={() => void startFlow("start-disconnect")}>
									Disconnect From Stripe
								</button>
							)}
							{(settings.keySource !== "connect" || health?.needsReconnect) && (
								<button type="button" style={secondaryButton} disabled={busy} onClick={() => void removeKey(settings.keySource === "connect")}>
									Remove key from this site
								</button>
							)}
						</div>
						<p style={{ ...muted, marginTop: 12 }}>
							<a
								href={`https://dashboard.stripe.com/${settings.environment === "sandbox" ? "test/" : ""}dashboard`}
								target="_blank"
								rel="noopener noreferrer"
								style={{ color: "#635bff" }}
							>
								Open your Stripe dashboard
							</a>
						</p>
					</>
				) : (
					connectButtons
				)}
				<details
					style={{ marginTop: 16 }}
					open={manualOpen}
					onToggle={(event) => setManualOpen((event.currentTarget as HTMLDetailsElement).open)}
				>
					<summary style={{ cursor: "pointer", fontSize: 14 }}>
						{settings.key?.type === "restricted" ? "Update your restricted key" : "Use your own Stripe key instead of Connect"}
					</summary>
					<p style={{ fontSize: 14, margin: "8px 0" }}>
						We recommend a restricted key (rk_…). In your{" "}
						<a
							href={`https://dashboard.stripe.com/${settings.environment === "sandbox" ? "test/" : ""}apikeys`}
							target="_blank"
							rel="noopener noreferrer"
							style={{ color: "#635bff" }}
						>
							Stripe API keys page
						</a>
						, click <strong>Create restricted key</strong>, leave every resource at <strong>None</strong> except:
					</p>
					<PermissionChecklist />
					<p style={{ ...muted, margin: "8px 0" }}>
						Write includes Read. A full secret key (sk_…) also works. There is no platform fee either way. The key is
						encrypted with EMDASH_ENCRYPTION_KEY and is never shown again. Saving a restricted key checks its
						permissions right away.
					</p>
					<input
						type="password"
						autoComplete="off"
						value={manualKey}
						onChange={(event) => setManualKey(event.target.value)}
						placeholder="rk_live_…"
						style={{ width: "100%", padding: "6px 10px", marginBottom: 8, font: "inherit" }}
					/>
					<button type="button" style={buttonStyle} disabled={busy || !manualKey.trim()} onClick={() => void save({ secretKey: manualKey.trim() }, "Stripe key saved.")}>
						Save key
					</button>
				</details>
			</Section>

			<Section title="2. Create products in Stripe">
				<p style={{ fontSize: 14 }}>
					Create products with a default price in your{" "}
					<a href="https://dashboard.stripe.com/products" target="_blank" rel="noopener noreferrer" style={{ color: "#635bff" }}>
						Stripe dashboard
					</a>
					. One-time and recurring prices both work.
				</p>
			</Section>

			<Section title="3. Restrict content">
				<p style={{ fontSize: 14 }}>
					Open any saved post or page and use the <strong>Restrict With Stripe</strong> panel in the editor sidebar to
					choose which products grant access.
				</p>
			</Section>

			<Section title="4. Display">
				<label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
					<input
						type="checkbox"
						checked={settings.showExcerpts}
						disabled={busy}
						onChange={(event) => void save({ showExcerpts: event.target.checked }, "Display settings saved.")}
					/>
					Show the first paragraph of restricted content above the paywall
				</label>
				<p style={{ ...muted, marginTop: 8 }}>
					The paywall is rendered by the browser. Restricted text is still present in the page HTML unless your theme
					gates it on the server; see the plugin README.
				</p>
			</Section>
		</div>
	);
}

// ─── Restrictions page ───────────────────────────────────────────

function useProducts(enabled: boolean) {
	const [products, setProducts] = React.useState<Product[]>([]);
	const [error, setError] = React.useState<string | null>(null);
	React.useEffect(() => {
		if (!enabled) return;
		call<{ products: Product[] }>("admin/products")
			.then((data) => setProducts(data.products))
			.catch((cause) => setError(errorText(cause)));
	}, [enabled]);
	return { products, error };
}

function RestrictionsPage() {
	const [items, setItems] = React.useState<RestrictionItem[] | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const { products } = useProducts(true);

	const load = React.useCallback(() => {
		call<{ items: RestrictionItem[] }>("admin/restrictions", { action: "list" })
			.then((data) => setItems(data.items))
			.catch((cause) => setError(errorText(cause)));
	}, []);
	React.useEffect(load, [load]);

	const remove = async (item: RestrictionItem) => {
		if (!window.confirm(`Remove the restriction from ${item.title ?? item.contentId}?`)) return;
		try {
			await call("admin/restrictions", { action: "delete", collection: item.collectionSlug, id: item.contentId });
			load();
		} catch (cause) {
			setError(errorText(cause));
		}
	};

	const productName = (id: string) => products.find((product) => product.id === id)?.name ?? id;

	return (
		<div style={{ maxWidth: 760, padding: 16 }}>
			<h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Restricted Content</h2>
			{error && <Notice tone="error">{error}</Notice>}
			{!items ? (
				<p>Loading…</p>
			) : items.length === 0 ? (
				<p style={{ fontSize: 14 }}>Nothing is restricted yet. Use the Restrict With Stripe panel when editing an entry.</p>
			) : (
				<ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
					{items.map((item) => (
						<li
							key={`${item.collectionSlug}:${item.contentId}`}
							style={{ padding: "10px 0", borderBottom: "1px solid rgba(127,127,127,0.25)", display: "flex", justifyContent: "space-between", gap: 12 }}
						>
							<div>
								<a
									href={`/_emdash/admin/content/${encodeURIComponent(item.collectionSlug)}/${encodeURIComponent(item.contentId)}`}
									style={{ fontWeight: 500, fontSize: 14, color: "inherit" }}
								>
									{item.title ?? item.slug ?? item.contentId}
								</a>
								<div style={muted}>
									{item.collectionSlug} · {item.productIds.map(productName).join(", ")}
								</div>
							</div>
							<button type="button" style={{ ...linkButton, color: "#dc2626", fontSize: 13 }} onClick={() => void remove(item)}>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

// ─── Dashboard widget ────────────────────────────────────────────

function OverviewWidget() {
	const [data, setData] = React.useState<{ settings: Settings; count: number } | null>(null);
	const [failed, setFailed] = React.useState(false);
	React.useEffect(() => {
		Promise.all([
			call<Settings>("admin/settings", { action: "get" }),
			call<{ items: RestrictionItem[] }>("admin/restrictions", { action: "list" }),
		])
			.then(([settings, restrictions]) => setData({ settings, count: restrictions.items.length }))
			.catch(() => setFailed(true));
	}, []);
	if (failed) return <p style={muted}>Unavailable</p>;
	if (!data) return <p style={muted}>Loading…</p>;
	const { settings, count } = data;
	return (
		<div style={{ fontSize: 14, display: "grid", gap: 6 }}>
			<div style={{ display: "flex", justifyContent: "space-between" }}>
				<span style={muted}>Stripe</span>
				<span style={{ fontWeight: 500, color: settings.configured ? "#059669" : "#dc2626" }}>
					{settings.configured ? `Connected${settings.environment === "sandbox" ? " (sandbox)" : ""}` : "Not connected"}
				</span>
			</div>
			<div style={{ display: "flex", justifyContent: "space-between" }}>
				<span style={muted}>Restricted entries</span>
				<span style={{ fontWeight: 500 }}>{count}</span>
			</div>
		</div>
	);
}

// ─── Editor panel ────────────────────────────────────────────────

interface PanelProps {
	entry: { id: string; slug?: string | null };
	collection: string;
	locale?: string;
}

function RestrictionPanel({ entry, collection }: PanelProps) {
	const [configured, setConfigured] = React.useState<boolean | null>(null);
	const [selected, setSelected] = React.useState<string[]>([]);
	const [saved, setSaved] = React.useState<string[]>([]);
	const [status, setStatus] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const [busy, setBusy] = React.useState(false);
	const { products, error: productError } = useProducts(configured === true);

	React.useEffect(() => {
		let cancelled = false;
		call<Settings>("admin/settings", { action: "get" })
			.then(async (settings) => {
				if (cancelled) return;
				setConfigured(settings.configured);
				const restriction = await call<{ productIds: string[] }>("admin/restrictions", {
					action: "get",
					collection,
					id: entry.id,
				});
				if (cancelled) return;
				setSelected(restriction.productIds);
				setSaved(restriction.productIds);
			})
			.catch((cause) => setStatus({ tone: "error", text: errorText(cause) }));
		return () => {
			cancelled = true;
		};
	}, [collection, entry.id]);

	const toggle = (id: string, checked: boolean) => {
		setStatus(null);
		setSelected((current) => (checked ? [...new Set([...current, id])] : current.filter((value) => value !== id)));
	};

	const save = async () => {
		setBusy(true);
		try {
			const result = await call<{ productIds: string[] }>("admin/restrictions", {
				action: "set",
				collection,
				id: entry.id,
				productIds: selected,
			});
			setSaved(result.productIds);
			setSelected(result.productIds);
			setStatus({ tone: "ok", text: result.productIds.length ? "Restriction saved." : "Restriction removed." });
		} catch (cause) {
			setStatus({ tone: "error", text: errorText(cause) });
		}
		setBusy(false);
	};

	if (configured === null) return <p style={muted}>{status ? status.text : "Loading…"}</p>;
	if (!configured) {
		return (
			<p style={muted}>
				Connect Stripe on the{" "}
				<a href="/_emdash/admin/plugins/restrict-with-stripe/settings" style={{ color: "#635bff" }}>
					Restrict With Stripe settings
				</a>{" "}
				page first.
			</p>
		);
	}

	const dirty = selected.slice().sort().join(",") !== saved.slice().sort().join(",");
	// Products that are restricting this entry but are no longer active in Stripe.
	const missing = selected.filter((id) => !products.some((product) => product.id === id));

	return (
		<div style={{ fontSize: 14 }}>
			<p style={{ ...muted, marginBottom: 8 }}>
				{saved.length ? "Visitors need one of the checked products to view this entry." : "Not restricted. Check a product to require it."}
			</p>
			{productError && <Notice tone="error">{productError}</Notice>}
			{products.length === 0 && !productError && <p style={muted}>No active products found in Stripe.</p>}
			{[...products.map((product) => ({ id: product.id, label: product.name, detail: product.price })), ...missing.map((id) => ({ id, label: id, detail: "inactive or missing" }))].map(
				(option) => (
					<label key={option.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0", cursor: "pointer" }}>
						<input type="checkbox" checked={selected.includes(option.id)} onChange={(event) => toggle(option.id, event.target.checked)} />
						<span>
							{option.label}
							{option.detail && <span style={{ ...muted, display: "block" }}>{option.detail}</span>}
						</span>
					</label>
				),
			)}
			<button type="button" style={{ ...buttonStyle, marginTop: 8 }} disabled={busy || !dirty} onClick={() => void save()}>
				{busy ? "Saving…" : "Save restriction"}
			</button>
			{status && <Notice tone={status.tone}>{status.text}</Notice>}
		</div>
	);
}

// ─── Exports ─────────────────────────────────────────────────────

export const pages = {
	"/settings": SettingsPage,
	"/restrictions": RestrictionsPage,
};

export const widgets = {
	overview: OverviewWidget,
};

export const contentEditorPanels = [
	{
		id: "restrict-with-stripe",
		title: "Restrict With Stripe",
		component: RestrictionPanel,
		// The restriction routes require plugins:manage, which EmDash grants to administrators.
		minRole: 50,
		order: 50,
	},
];
