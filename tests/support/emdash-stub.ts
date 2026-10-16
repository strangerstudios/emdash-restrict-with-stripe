// Minimal stand-in for the "emdash" runtime exports the plugin imports.

export class PluginRouteError extends Error {
	constructor(
		public code: string,
		message: string,
		public status = 400,
	) {
		super(message);
		this.name = "PluginRouteError";
	}
}

export function definePlugin<T>(definition: T): T {
	return definition;
}
