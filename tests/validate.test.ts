import { describe, expect, it } from "vitest";

import { appendRawParam, escapeHtml, normalizeEmail, siteOriginFrom, validateReturnPath } from "../src/lib/validate.js";

const SITE = "https://example.test";

describe("validateReturnPath", () => {
	it.each([
		["/\\evil.com"],
		["/\\\\evil.com"],
		["/\t/evil.com"],
		["/\n/evil.com"],
		["/\r\n/evil.com"],
		["/\u0000/evil.com"],
		["/\u0085/evil.com"],
		["//evil.com"],
		["///evil.com"],
		["https://evil.com"],
		["https://example.test/post"],
		["http:/evil.com"],
		["javascript:alert(1)"],
		["evil.com"],
		["/.//evil.com"],
		[""],
		[" /post"],
		["/" + "a".repeat(2048)],
	])("rejects %j", (path) => {
		expect(validateReturnPath(path, SITE)).toBeNull();
	});

	it("rejects non-strings", () => {
		expect(validateReturnPath(undefined, SITE)).toBeNull();
		expect(validateReturnPath(["/post"], SITE)).toBeNull();
	});

	it.each([
		["/", "/"],
		["/posts/hello", "/posts/hello"],
		["/posts/hello?ref=1", "/posts/hello?ref=1"],
		["/posts/hello#comments", "/posts/hello"],
		["/posts/./hello", "/posts/hello"],
		["/posts/%2F%2Fevil.com", "/posts/%2F%2Fevil.com"],
	])("accepts %j as %j", (path, expected) => {
		expect(validateReturnPath(path, SITE)).toBe(expected);
	});

	it("strips one-time rwstripe parameters", () => {
		expect(validateReturnPath("/p?a=1&rwstripe_login=abc&rwstripe_checkout=cs_test_1", SITE)).toBe("/p?a=1");
	});

	it("keeps every accepted path on the site origin", () => {
		for (const path of ["/", "/a/b?c=d", "/%5Cevil.com", "/@evil.com", "/:evil.com"]) {
			const normalized = validateReturnPath(path, SITE);
			expect(normalized).not.toBeNull();
			expect(new URL(`${SITE}${normalized}`).origin).toBe(SITE);
		}
	});
});

describe("siteOriginFrom", () => {
	it("accepts https origins and strips paths", () => {
		expect(siteOriginFrom("https://example.test/blog/")).toBe("https://example.test");
	});
	it("accepts http only for loopback", () => {
		expect(siteOriginFrom("http://localhost:4321")).toBe("http://localhost:4321");
		expect(siteOriginFrom("http://example.test")).toBeNull();
	});
	it("rejects empty and relative values", () => {
		expect(siteOriginFrom("")).toBeNull();
		expect(siteOriginFrom("/")).toBeNull();
		expect(siteOriginFrom(undefined)).toBeNull();
	});
});

describe("helpers", () => {
	it("normalizes emails", () => {
		expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
		expect(normalizeEmail("not-an-email")).toBeNull();
		expect(normalizeEmail("a@b")).toBeNull();
		expect(normalizeEmail("x@y.z\n<script>")).toBeNull();
	});
	it("appends the literal Checkout placeholder", () => {
		expect(appendRawParam("https://example.test/p", "rwstripe_checkout", "{CHECKOUT_SESSION_ID}")).toBe(
			"https://example.test/p?rwstripe_checkout={CHECKOUT_SESSION_ID}",
		);
		expect(appendRawParam("https://example.test/p?a=1", "x", "y")).toBe("https://example.test/p?a=1&x=y");
	});
	it("escapes HTML", () => {
		expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
	});
});
