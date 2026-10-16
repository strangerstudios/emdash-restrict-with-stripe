import { describe, expect, it } from "vitest";
import { formatPrice } from "../src/lib/products.js";
import type { StripePrice } from "../src/lib/stripe.js";

const base: StripePrice = { id: "price_1", active: true, currency: "usd", unit_amount: 500, type: "one_time", recurring: null, product: "prod_1" };

describe("formatPrice", () => {
	it("formats fixed and recurring prices", () => {
		expect(formatPrice(base)).toBe("$5.00");
		expect(formatPrice({ ...base, type: "recurring", recurring: { interval: "year", interval_count: 1 } })).toBe("$5.00 / year");
		expect(formatPrice({ ...base, type: "recurring", recurring: { interval: "month", interval_count: 3 } })).toBe("$5.00 every 3 months");
	});

	it("labels pay-what-you-want prices", () => {
		const custom = { ...base, unit_amount: null };
		expect(formatPrice({ ...custom, custom_unit_amount: { minimum: 100, maximum: null, preset: 300 } })).toBe("Pay what you want (min $1.00)");
		expect(formatPrice({ ...custom, custom_unit_amount: { minimum: null, maximum: null, preset: null } })).toBe("Pay what you want");
		expect(formatPrice(custom)).toBeNull();
	});
});
