// Browser code injected through page:fragments. Kept as plain ES2017 strings because
// fragments are inlined into the page; String.raw keeps regex backslashes intact.
// Everything user- or Stripe-supplied is inserted with textContent, never as HTML.

export const PAYWALL_CSS = String.raw`
.rwstripe-pending [data-rwstripe-content], .rwstripe-pending article { visibility: hidden; }
.rwstripe-paywall { max-width: 420px; margin: 2rem auto; padding: 1.5rem; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; color: #111827; font-family: system-ui, -apple-system, sans-serif; font-size: 0.9375rem; line-height: 1.5; }
.rwstripe-paywall h2 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75rem; }
.rwstripe-paywall p { margin: 0 0 0.75rem; }
.rwstripe-tabs { display: flex; gap: 0.25rem; margin-bottom: 1rem; border-bottom: 1px solid #e5e7eb; }
.rwstripe-tab { flex: 1; padding: 0.5rem; background: none; border: 0; border-bottom: 2px solid transparent; color: #6b7280; font: inherit; font-weight: 500; cursor: pointer; }
.rwstripe-tab[aria-selected="true"] { color: #635bff; border-bottom-color: #635bff; }
.rwstripe-paywall label { display: block; font-size: 0.8125rem; font-weight: 500; margin-bottom: 0.25rem; }
.rwstripe-paywall input[type="email"], .rwstripe-paywall select { box-sizing: border-box; width: 100%; padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; background: #fff; color: #111827; }
.rwstripe-button { width: 100%; padding: 0.625rem 1rem; background: #635bff; color: #fff; border: 0; border-radius: 6px; font: inherit; font-weight: 500; cursor: pointer; }
.rwstripe-button:hover { background: #5046e5; }
.rwstripe-button:disabled { opacity: 0.6; cursor: not-allowed; }
.rwstripe-link { background: none; border: 0; padding: 0; color: #635bff; font: inherit; text-decoration: underline; cursor: pointer; }
.rwstripe-error { color: #dc2626; }
.rwstripe-error:empty, .rwstripe-status:empty { display: none; }
.rwstripe-status { color: #047857; }
.rwstripe-product { font-weight: 600; margin-bottom: 0.75rem; }
.rwstripe-excerpt { opacity: 0.75; }
.rwstripe-member-bar { margin: 1.5rem 0; padding: 0.75rem 1rem; border-top: 1px solid #e5e7eb; font-size: 0.875rem; color: #6b7280; }
.rwstripe-member-bar .rwstripe-link { margin-left: 0.75rem; }
.rwstripe-paywall [hidden] { display: none !important; }
`;

export const ONE_TIME_PARAMS = ["rwstripe_checkout", "rwstripe_login"] as const;

/**
 * Runs in <head> on every content page: moves one-time Checkout and login values out
 * of the address bar before later scripts (analytics) can read the URL.
 */
export const EARLY_JS = String.raw`(function(){try{var u=new URL(location.href),p={},n=0;["rwstripe_checkout","rwstripe_login"].forEach(function(k){var v=u.searchParams.get(k);if(v!==null){p[k]=v;u.searchParams.delete(k);n++;}});if(n){window.__rwstripeParams=p;history.replaceState(history.state,"",u.pathname+u.search+u.hash);}}catch(e){}})();`;

/** Runs in <head> on entries that were restricted at render time, to avoid a flash of content. */
export const PENDING_JS = String.raw`(function(){var r=document.documentElement;r.classList.add("rwstripe-pending");setTimeout(function(){r.classList.remove("rwstripe-pending");},8000);})();`;

export const PAYWALL_JS = String.raw`
(function (cfg) {
  "use strict";
  var API = cfg.api;
  var COOKIE = "rwstripe_session";
  var SECURE = location.protocol === "https:" ? "; Secure" : "";
  var root = document.documentElement;

  function reveal() { root.classList.remove("rwstripe-pending"); }

  function readSession() {
    var match = document.cookie.match(/(?:^|;\s*)rwstripe_session=([A-Za-z0-9_-]{43})(?:;|$)/);
    return match ? match[1] : null;
  }
  function writeSession(token) {
    document.cookie = COOKIE + "=" + token + "; Path=/; Max-Age=2592000; SameSite=Lax" + SECURE;
  }
  function clearSession() {
    document.cookie = COOKIE + "=; Path=/; Max-Age=0; SameSite=Lax" + SECURE;
  }

  function post(route, payload) {
    return fetch(API + route, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (res.ok && json && json.success !== false) return json.data;
        var error = new Error((json && json.error && json.error.message) || "Something went wrong. Please try again.");
        error.code = json && json.error && json.error.code;
        throw error;
      });
    });
  }

  function currentPath() {
    var url = new URL(location.href);
    url.searchParams.delete("rwstripe_checkout");
    url.searchParams.delete("rwstripe_login");
    return url.pathname + url.search;
  }

  // Read a one-time URL parameter (already moved aside by the head script, or still in
  // the URL if that script did not run) and remove it from the address bar and history.
  function takeParam(name) {
    var early = window.__rwstripeParams;
    if (early && Object.prototype.hasOwnProperty.call(early, name)) {
      var stashed = early[name];
      delete early[name];
      return stashed;
    }
    var url = new URL(location.href);
    var value = url.searchParams.get(name);
    if (value === null) return null;
    url.searchParams.delete(name);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    return value;
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === "text") node.textContent = props[key];
        else if (key === "className") node.className = props[key];
        else if (key === "hidden") node.hidden = !!props[key];
        else node.setAttribute(key, props[key]);
      });
    }
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function navigate(url) {
    if (typeof url === "string" && /^https:\/\//.test(url)) location.assign(url);
  }

  function openPortal(button) {
    var session = readSession();
    if (!session) return;
    if (button) button.disabled = true;
    post("/portal", { session: session, return_path: currentPath() }).then(function (data) {
      navigate(data.url);
    }).catch(function (error) {
      if (button) button.disabled = false;
      window.alert(error.message);
    });
  }

  function logout() {
    var session = readSession();
    clearSession();
    var done = function () { location.reload(); };
    if (!session) return done();
    post("/auth/logout", { session: session }).then(done, done);
  }

  function findContainer() {
    return document.querySelector("[data-rwstripe-content]") || document.querySelector("article") || document.querySelector("main");
  }

  function memberBar(email) {
    var container = findContainer();
    if (!container) return;
    var portal = el("button", { type: "button", className: "rwstripe-link", text: "Manage purchases" });
    portal.addEventListener("click", function () { openPortal(portal); });
    var out = el("button", { type: "button", className: "rwstripe-link", text: "Log out" });
    out.addEventListener("click", logout);
    container.appendChild(el("div", { className: "rwstripe-member-bar" }, [
      document.createTextNode("Logged in as " + email + "."), portal, out
    ]));
  }

  function buildPaywall(access, products, notice) {
    var errorBox = el("div", { className: "rwstripe-error", role: "alert", text: notice || "" });
    var children = [el("h2", { text: "Purchase access to continue" })];

    if (access.email) {
      var out = el("button", { type: "button", className: "rwstripe-link", text: "Log out" });
      out.addEventListener("click", logout);
      children.push(el("p", null, [
        document.createTextNode("You are logged in as " + access.email + ", which does not have access to this content. "),
        out
      ]));
    }

    var purchaseTab = el("button", { type: "button", className: "rwstripe-tab", role: "tab", "aria-selected": "true", text: "Purchase" });
    var loginTab = el("button", { type: "button", className: "rwstripe-tab", role: "tab", "aria-selected": "false", text: "Log In" });

    // Purchase panel
    var buyEmail = el("input", { type: "email", name: "email", required: "required", autocomplete: "email", id: "rwstripe-buy-email" });
    if (access.email) buyEmail.value = access.email;
    var picker;
    if (products.length === 1) {
      picker = el("div", { className: "rwstripe-product", text: products[0].name + (products[0].price ? " - " + products[0].price : "") });
      picker.dataset.priceId = products[0].priceId;
    } else if (products.length > 1) {
      picker = el("select", { name: "price", required: "required", "aria-label": "Product" }, [el("option", { value: "", text: "Choose a product" })]);
      products.forEach(function (product) {
        picker.appendChild(el("option", { value: product.priceId, text: product.name + (product.price ? " - " + product.price : "") }));
      });
    } else {
      picker = el("p", { text: "This content is not available for purchase right now." });
    }
    var buyButton = el("button", { type: "submit", className: "rwstripe-button", text: "Continue to Checkout" });
    if (products.length === 0) buyButton.disabled = true;
    var purchaseForm = el("form", { role: "tabpanel" }, [
      el("label", { "for": "rwstripe-buy-email", text: "Email address" }), buyEmail, picker, buyButton
    ]);
    purchaseForm.addEventListener("submit", function (event) {
      event.preventDefault();
      errorBox.textContent = "";
      var priceId = picker.tagName === "SELECT" ? picker.value : picker.dataset.priceId;
      if (!priceId) { errorBox.textContent = "Choose a product."; return; }
      buyButton.disabled = true;
      post("/checkout", { price_id: priceId, email: buyEmail.value, return_path: currentPath() }).then(function (data) {
        navigate(data.url);
      }).catch(function (error) {
        errorBox.textContent = error.message;
        buyButton.disabled = false;
      });
    });

    // Log-in panel
    var loginEmail = el("input", { type: "email", name: "email", required: "required", autocomplete: "email", id: "rwstripe-login-email" });
    var loginButton = el("button", { type: "submit", className: "rwstripe-button", text: "Email Me a Login Link" });
    var status = el("p", { className: "rwstripe-status", role: "status" });
    var loginForm = el("form", { role: "tabpanel", hidden: true }, [
      el("p", { text: "Already purchased? We'll email you a link to log in." }),
      el("label", { "for": "rwstripe-login-email", text: "Email address" }), loginEmail, loginButton, status
    ]);
    loginForm.addEventListener("submit", function (event) {
      event.preventDefault();
      errorBox.textContent = "";
      status.textContent = "";
      loginButton.disabled = true;
      post("/auth/send-link", { email: loginEmail.value, return_path: currentPath() }).then(function (data) {
        status.textContent = data.message;
      }).catch(function (error) {
        errorBox.textContent = error.message;
      }).then(function () { loginButton.disabled = false; });
    });

    function select(tab) {
      var buying = tab === purchaseTab;
      purchaseTab.setAttribute("aria-selected", String(buying));
      loginTab.setAttribute("aria-selected", String(!buying));
      purchaseForm.hidden = !buying;
      loginForm.hidden = buying;
      errorBox.textContent = "";
    }
    purchaseTab.addEventListener("click", function () { select(purchaseTab); });
    loginTab.addEventListener("click", function () { select(loginTab); });

    children.push(el("div", { className: "rwstripe-tabs", role: "tablist" }, [purchaseTab, loginTab]), errorBox, purchaseForm, loginForm);
    return el("div", { className: "rwstripe-paywall" }, children);
  }

  function gate(access, notice) {
    var container = findContainer();
    if (!container) { reveal(); return; }
    var kept = [];
    var heading = container.querySelector("h1");
    if (heading) kept.push(heading.cloneNode(true));
    if (cfg.showExcerpts) {
      var first = container.querySelector("p");
      if (first) kept.push(el("div", { className: "rwstripe-excerpt" }, [first.cloneNode(true)]));
    }
    var load = post("/products", {}).then(function (data) {
      var wanted = access.productIds || [];
      return (data.products || []).filter(function (product) { return wanted.indexOf(product.id) !== -1; });
    }).catch(function () { return []; });
    load.then(function (products) {
      while (container.firstChild) container.removeChild(container.firstChild);
      kept.forEach(function (node) { container.appendChild(node); });
      container.appendChild(buildPaywall(access, products, notice));
      reveal();
    });
  }

  function checkAccess(session) {
    return post("/access", { collection: cfg.content.collection, id: cfg.content.id, session: session || undefined })
      .catch(function () { return { restricted: true, hasAccess: false, productIds: [], failed: true }; });
  }

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function run() {
    var notice = null;
    var justPurchased = false;
    var checkoutId = takeParam("rwstripe_checkout");
    var loginToken = takeParam("rwstripe_login");
    var step = Promise.resolve();
    if (checkoutId) {
      step = post("/checkout/complete", { session_id: checkoutId }).then(function (data) {
        writeSession(data.session);
        justPurchased = true;
      }, function (error) { notice = error.message; });
    } else if (loginToken) {
      step = post("/auth/verify", { token: loginToken }).then(function (data) {
        writeSession(data.session);
      }, function (error) { notice = error.message; });
    }

    step.then(function () {
      var session = readSession();
      return checkAccess(session).then(function (access) {
        // Stripe can take a moment to show a brand-new purchase.
        if (justPurchased && access.restricted && !access.hasAccess) {
          return wait(3000).then(function () { return checkAccess(session); });
        }
        return access;
      }).then(function (access) {
        if (session && access.restricted && !access.email && !access.failed) {
          clearSession();
        }
        if (!access.restricted) { reveal(); return; }
        if (access.hasAccess) { reveal(); memberBar(access.email); return; }
        if (access.failed && !notice) notice = "We couldn't check your access. Please reload the page.";
        gate(access, notice);
      });
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target.closest(".rwstripe-portal-link, .rwstripe-logout-link") : null;
    if (!target) return;
    event.preventDefault();
    if (target.classList.contains("rwstripe-portal-link")) openPortal(target);
    else logout();
  });

  window.RWStripe = { openPortal: function () { openPortal(null); }, logout: logout, hasSession: function () { return !!readSession(); } };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})
`;

/** JSON for an inline script: escapes characters that could end the script or break JS parsing. */
export function inlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

export interface PaywallConfig {
	api: string;
	content: { collection: string; id: string; slug: string | null };
	showExcerpts: boolean;
}

export function paywallScript(config: PaywallConfig): string {
	return `${PAYWALL_JS.trim()}(${inlineJson(config)});`;
}
