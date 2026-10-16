// Descriptor factory for astro.config.mjs, plus the named createPlugin() export that
// EmDash's native loader imports from the same entrypoint.

import type { PluginDescriptor } from "emdash";

import { PLUGIN_ID, PLUGIN_VERSION } from "./lib/context.js";
import { ADMIN_ENTRY } from "./plugin.js";

export { createPlugin } from "./plugin.js";

export function restrictWithStripe(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: "emdash-restrict-with-stripe",
		adminEntry: ADMIN_ENTRY,
		options: {},
	};
}

export default restrictWithStripe;
