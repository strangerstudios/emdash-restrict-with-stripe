import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// The real "emdash" entry needs a full Astro host; handlers only use PluginRouteError.
		alias: [{ find: /^emdash$/, replacement: fileURLToPath(new URL("./tests/support/emdash-stub.ts", import.meta.url)) }],
	},
	test: {
		include: ["tests/**/*.test.ts"],
	},
});
