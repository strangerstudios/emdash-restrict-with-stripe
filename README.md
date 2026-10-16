# Restrict With Stripe for EmDash

Sell access to posts and pages with Stripe. Restrict an entry to one or more Stripe products; visitors buy through Stripe Checkout and are logged in when they return, and returning customers log in with an emailed link. It is the EmDash counterpart of the [Restrict With Stripe](https://github.com/strangerstudios/restrict-with-stripe) WordPress plugin and uses the same Stripe Connect server and the same access rule.

**No platform fee.** The plugin never adds an application fee to any Stripe request, whether you connect through Stripe Connect or use your own key. You pay Stripe's normal processing fees and nothing else.

Version 0.2.0 targets **EmDash 1.x** (tested on 1.3.0) as a native plugin.

## Requirements

- EmDash `>=1.0.0` with React (`@astrojs/react`), which every EmDash admin already uses.
- **`EMDASH_ENCRYPTION_KEY`** set in the site's environment. The Stripe key is stored as an encrypted plugin setting, and the plugin refuses to store a key it cannot encrypt. Generate one with `emdash secrets generate`.
- **An absolute site URL.** Login links, Checkout return URLs, and the Connect return URL are built from `ctx.site.url`, never from the request `Host` header. Set `siteUrl` in the `emdash()` integration, the `EMDASH_SITE_URL` environment variable, or **Settings > General > Site URL** (an HTTPS origin; plain HTTP only for localhost). Without one, Connect, checkout, login links, and the billing portal return `SITE_URL_NOT_CONFIGURED`. EmDash reads the site URL when the runtime starts, so restart the server after changing it in Settings.
- **An email provider** for login links (`ctx.email` exists only when the site has an `email:deliver` provider). In `astro dev`, EmDash's console provider prints messages to the server log. Without a provider, buyers are still logged in automatically after Checkout, but returning visitors cannot request a link.
- A theme layout that renders `<EmDashHead page={...} />` and `<EmDashBodyEnd page={...} />` and passes `content: { collection, id, slug }` to `createPublicPageContext()` on entry pages. The EmDash blog template already does this. The paywall only loads on pages whose context has `kind: "content"`.

## Install

```bash
npm install emdash-restrict-with-stripe
```

```js
// astro.config.mjs
import emdash from "emdash/astro";
import { restrictWithStripe } from "emdash-restrict-with-stripe";

export default defineConfig({
	integrations: [
		emdash({
			// siteUrl: "https://example.com",
			plugins: [restrictWithStripe()],
		}),
	],
});
```

This is a native plugin: it runs in the site's process and ships trusted React admin components and page scripts. It declares `content:read` (entry titles on the Restrictions page), `network:request` limited to `api.stripe.com`, `hooks.page-fragments:register` (paywall CSS and script), and `email:send` (login links).

## Connect Stripe

Open **Restrict With Stripe** in the admin sidebar.

- **Connect to Stripe** sends you through `https://connect.restrictwithstripe.com` (tick the sandbox box for test mode). The return URL carries a single-use state value that the plugin issued for your admin account, so a crafted link containing someone else's Stripe keys cannot be saved, and the returned key is checked against Stripe (`GET /v1/account`) before it is stored. The connection is recorded with `supports_hash=1`, so the Connect server keeps only `sha256(access token)`.
- **Disconnect From Stripe** sends you to the Connect server's confirmation page with `key_hash = sha256(access token)`. Keys stay on the site until the server returns `pmpro_stripe_disconnected=true` for this site's account; if you cancel or sign in to a different account, the keys are kept and the server's message is shown.
- If Stripe stops accepting a Connect key (revoked or disconnected from the Stripe dashboard), the settings page shows **Reconnect to Stripe**. If it stops accepting a key you entered yourself, the page asks you to **update your restricted key** (or secret key) instead.
- **Use your own Stripe key instead of Connect** accepts a secret key (`sk_…`) or, recommended, a restricted key (`rk_…`). The same field is available in EmDash's generated settings form for the plugin.

### Bring your own restricted key

In the Stripe Dashboard, open **Developers > API keys** ([live](https://dashboard.stripe.com/apikeys), [sandbox](https://dashboard.stripe.com/test/apikeys)), click **Create restricted key**, and set these permissions. Leave every other resource at **None**.

| Resource | Permission | Used for |
|---|---|---|
| Products | Read | Product list for restrictions and the paywall (`GET /v1/products`, `GET /v1/prices/:id?expand[]=product`) |
| Prices | Read | Prices on the paywall and the price being bought (`GET /v1/prices/:id`, `expand[]=data.default_price`) |
| Customers | Read | Finding a member's customers by email; expanding the Checkout customer (`GET /v1/customers`) |
| Subscriptions | Read | Access check: active or trialing subscriptions (`GET /v1/subscriptions`) |
| Invoices | Read | Access check: paid one-time purchases (`GET /v1/invoices`) |
| Checkout Sessions | Write | Creating Checkout and verifying the buyer's return (`POST /v1/checkout/sessions`, `GET /v1/checkout/sessions/:id`) |
| Customer Portal | Write | Creating the default portal configuration if none exists, and portal sessions (`/v1/billing_portal/configurations`, `POST /v1/billing_portal/sessions`) |
| Accounts | Read (optional) | Showing the account ID in settings (`GET /v1/account`); everything works without it |
| Everything else | None | Not used |

Write includes Read. Permission names follow Stripe's [restricted API keys](https://docs.stripe.com/keys/restricted-api-keys) guide and [permissions reference](https://docs.stripe.com/stripe-apps/reference/permissions) (where Prices appear as the `plan` resource). Nothing here can move money out of the account, issue refunds, or charge application fees.

After a restricted key is saved, the settings page runs **Check key permissions** (`admin/permissions`): one read-only `limit=1` list call per resource, reporting each permission as OK or Missing with the permission Stripe names in its 403. Write permissions (Checkout Sessions, Customer Portal) cannot be tested without creating something, so the check confirms their read half and reports them as "not verifiable until first use". If a live checkout, portal, product, or access call later fails with a permission error, the plugin logs it, records which permission Stripe named (no key material), and shows "Your restricted key is missing Checkout Sessions: Write" on the settings page and in key health. Visitors only see the generic Stripe error.

## Restrict content

Create products with a default price in Stripe. Then open a saved entry in the admin and use the **Restrict With Stripe** panel in the editor sidebar to tick the products that grant access. The panel and the admin routes behind it require the `plugins:manage` permission (administrators). **Restricted Content** lists every restricted entry. Restrictions are stored per entry ID (`collection:id`), so renaming a slug does not drop a restriction.

## How gating works

On a restricted entry the plugin adds a small stylesheet and script to the page:

1. The script posts `{collection, id, session}` to the `access` route. The entry is restricted if any products are attached to it.
2. Access means a Stripe customer with the session's email has an `active` or `trialing` subscription to one of the products, or a paid invoice for one outside a subscription (invoices with `rwstripe-ignore` metadata are skipped). This is the WordPress plugin's rule. Positive results are cached for five minutes.
3. Without access, the article is replaced by the title, an optional first-paragraph excerpt, and a paywall with **Purchase** (email + product → Stripe Checkout) and **Log In** (email → login link) tabs. The paywall uses the element marked `data-rwstripe-content`, else the first `<article>`, else `<main>`.

Member sessions:

- **Checkout.** One-time prices use `mode=payment` with `invoice_creation[enabled]=true` (otherwise a one-time purchase never appears as a paid invoice) and `customer_creation=always`; recurring prices use `mode=subscription`. Only active prices of products that restrict at least one entry can be sold. The buyer's email is passed as `customer_email` and the checkout is never attached to an existing customer, because nobody has proven they own that address yet. Stripe returns the buyer to the page with `rwstripe_checkout={CHECKOUT_SESSION_ID}`; `checkout/complete` retrieves the session from Stripe and issues a member session only if it was created by this plugin (`metadata.rwstripe=1`), is complete and paid (or needs no payment), is less than two hours old, and has not been redeemed before. That session covers **only the customer this Checkout created**: it cannot see purchases or open the billing portal of other customers with the same email. A magic-link login, which proves the email, covers every customer with that email.
- **Login links.** `auth/send-link` always answers with the same message (including when the email provider fails), and only emails addresses whose Stripe customers hold a product that restricts content, so the site cannot be used to send mail to arbitrary addresses. Links expire after 15 minutes and work once. The page script reads `rwstripe_login` from the URL and POSTs it to `auth/verify`, so link scanners that prefetch the URL cannot use up the token. Single use is enforced with a compare-and-delete on the token row: when two requests race, exactly one gets the session.
- A small head script moves `rwstripe_checkout` and `rwstripe_login` out of the address bar before later scripts run, and pages loaded with either parameter get `<meta name="referrer" content="no-referrer">`. Scripts that run before EmDash's head output can still see the URL; keep analytics after `<EmDashHead>`.
- Tokens are 32 random bytes (base64url). Only `sha256(token)` is stored. Sessions last 30 days and are stored client-side in a `rwstripe_session` cookie (`Path=/; SameSite=Lax; Secure; Max-Age=30d`). EmDash public plugin routes do not read cookies, so the script sends the token in the JSON body. The cookie is readable by JavaScript by necessity, which means script injection on the site could read it; a stolen session grants content access only, never admin access. A cookie was chosen over `localStorage` so the server-side helper below can read it.
- Rate limits (per email and per client IP, 15-minute windows): login links 3 per email and 10 per IP; checkout 5 per email and 20 per IP; checkout completion 10 per IP and 5 per email; login verification 20 per IP. EmDash only knows the client IP on Cloudflare or when `trustedProxyHeaders` is configured; otherwise the per-IP limits are skipped.

### Client-side gating is not a security boundary

The paywall script hides content in the browser. **The restricted text is still in the HTML** that EmDash renders, so anyone who disables JavaScript or views the source can read it. To keep premium text out of the HTML, gate it in your template with the server-side helper:

```astro
---
// src/pages/posts/[slug].astro (EmDash blog template)
import { getAccess } from "emdash-restrict-with-stripe/astro";

const { entry: post } = await getEmDashEntry("posts", slug);
const access = await getAccess(Astro, { collection: "posts", id: post.data.id });
const locked = access.restricted && !access.hasAccess;
---
<article class="article" data-rwstripe-content>
	<h1>{post.data.title}</h1>
	{locked ? <p>{post.data.excerpt}</p> : <PortableText value={post.data.content} />}
</article>
```

`getAccess()` reads the `rwstripe_session` cookie with `Astro.cookies` and calls the plugin's `access` route in-process through `Astro.locals.emdash.handlePublicPluginApiRoute`. It fails closed (`restricted: true, hasAccess: false`) if the plugin cannot be reached. Pages that use it vary per visitor, so do not cache them publicly. The paywall script still renders the purchase and login forms on the gated page.

## Routes

All routes live under `/_emdash/api/plugins/restrict-with-stripe/`. Public routes accept POST with a JSON body (`products` also accepts GET). Browser callers should send `X-EmDash-Request: 1`; EmDash rejects cross-origin POSTs to plugin routes.

| Route | Access | Body |
| --- | --- | --- |
| `access` | public | `{collection, id, session?}` → `{restricted, hasAccess, productIds, email?}` |
| `products` | public | → products that restrict content: `{id, name, description, priceId, price}` |
| `checkout` | public | `{price_id, email, return_path}` → `{url}` |
| `checkout/complete` | public | `{session_id}` → `{session, email, expiresAt}` |
| `auth/send-link` | public | `{email, return_path}` → generic `{ok, message}` |
| `auth/verify` | public | `{token}` → `{session, email, expiresAt, returnPath}` |
| `auth/logout` | public | `{session}` |
| `portal` | public | `{session, return_path}` → Stripe billing portal `{url}` |
| `admin/settings` | `plugins:manage` | `{action: "get" \| "save" \| "remove-key", …}`; never returns the key |
| `admin/restrictions` | `plugins:manage` | `{action: "list" \| "get" \| "set" \| "delete", collection, id, productIds}` |
| `admin/products` | `plugins:manage` | all active Stripe products |
| `admin/connect` | `plugins:manage` | `{action: "start-connect" \| "start-disconnect" \| "complete-connect" \| "complete-disconnect", …}` |
| `admin/key-health` | `plugins:manage` | `GET /v1/account` with the stored key; on 401, `needsReconnect` for Connect keys and `needsNewKey` for keys you entered; includes the last recorded permission error |
| `admin/permissions` | `plugins:manage` | Read-only permission probe of the stored key; per-permission `ok` / `missing` / `unverified` |

`return_path` must be a path on this site: it must start with a single `/` and contain no backslashes or control characters, and `new URL(return_path, siteUrl)` must stay on the site origin. Errors use EmDash's envelope, `{success: false, error: {code, message}}`, with codes such as `SITE_URL_NOT_CONFIGURED`, `STRIPE_NOT_CONFIGURED`, `EMAIL_NOT_CONFIGURED`, `INVALID_RETURN_PATH`, `PRICE_UNAVAILABLE`, `CHECKOUT_ALREADY_USED`, and `RATE_LIMITED`.

## Known limits

- Stripe's customer filter by email is case-sensitive. The plugin creates customers with lowercased emails and, for login links, looks up both the lowercased address and the spelling the visitor typed. A customer saved elsewhere as `Bob@Example.com` is found only when the visitor types exactly that spelling.
- Sessions are bearer tokens valid for 30 days. Access is re-checked against Stripe (with a five-minute positive cache), so a cancelled subscription or refund stops access even while the session is valid.
- `auth/send-link` returns the same response for every address, but an eligible address also triggers an email send, so its response time can differ slightly.
- Someone can send a visitor a link carrying the sender's own unused login token or Checkout Session ID, which logs the visitor in as the sender (login CSRF). It grants the visitor the sender's access, not the reverse.
- Stripe API calls pin `Stripe-Version: 2022-11-15`, the version the WordPress plugin uses.

## Upgrading from 0.1.x

0.1.x targeted pre-1.0 EmDash and is not compatible with 1.x. After upgrading, reconnect Stripe (0.1.x keys in plugin KV are not read), and re-save restrictions from the editor panel (0.1.x keyed them by slug). The 0.1.x theme snippets, `/account/verify` page, and `/assets/rwstripe.js` script tag are no longer needed; remove them.

## Development

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # dist/ for the server entry and the Astro helper
npm pack           # the admin UI ships as source (src/admin.tsx) for the host to compile
```

## Credits

Built by [Stranger Studios](https://strangerstudios.com), the team behind [Paid Memberships Pro](https://www.paidmembershipspro.com). Verifying the Checkout Session server-side before logging a buyer in, crypto-random tokens, sending login links through `ctx.email`, and the vitest setup come from Mason James's [PR #1](https://github.com/strangerstudios/emdash-restrict-with-stripe/pull/1).

## License

GPL-2.0-or-later
