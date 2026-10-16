// The restricted-key permission checklist, derived from every Stripe call in stripe.ts.
// Dependency-free so the admin UI can import it. Labels match the Dashboard's
// restricted-key editor; resource IDs match Stripe's permission names.

export type Access = "read" | "write";

export interface RequiredPermission {
	/** Stripe's permission resource ID (as in `rak_<resource>_<access>` and `<resource>_read`). */
	resource: string;
	/** Resource name as the Dashboard's restricted-key editor labels it. */
	label: string;
	access: Access;
	optional?: boolean;
	usedFor: string;
	/** List endpoint probed with limit=1 to confirm read access. */
	probePath: string;
}

export const REQUIRED_PERMISSIONS: readonly RequiredPermission[] = [
	{ resource: "product", label: "Products", access: "read", usedFor: "List products for restrictions and the paywall.", probePath: "/products" },
	{ resource: "plan", label: "Prices", access: "read", usedFor: "Show prices and look up the price being bought.", probePath: "/prices" },
	{ resource: "customer", label: "Customers", access: "read", usedFor: "Find a member's Stripe customers by email.", probePath: "/customers" },
	{ resource: "subscription", label: "Subscriptions", access: "read", usedFor: "Check active or trialing subscriptions.", probePath: "/subscriptions" },
	{ resource: "invoice", label: "Invoices", access: "read", usedFor: "Check paid one-time purchases.", probePath: "/invoices" },
	{ resource: "checkout_session", label: "Checkout Sessions", access: "write", usedFor: "Create Checkout and verify the buyer's return.", probePath: "/checkout/sessions" },
	{ resource: "customer_portal", label: "Customer Portal", access: "write", usedFor: "Create the portal configuration and portal sessions.", probePath: "/billing_portal/configurations" },
	{ resource: "connected_account", label: "Accounts", access: "read", optional: true, usedFor: "Optional: show the Stripe account ID in settings.", probePath: "/account" },
];
