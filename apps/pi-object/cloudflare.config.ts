import { bindings, defineConfig, exports } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .dev.vars, .dev.vars.example, .env. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	worker: {
		name: "durable-pi-object",
		compatibilityDate: "2026-11-18",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		workersDev: true,
		previewUrls: false,
		limits: {
			cpuMs: 30000,
			subrequests: 500,
		},
		env: {
			DEEPSEEK_API_KEY: bindings.secret(),
			DPI_TOKEN: bindings.secret(),
			CLOUDFLARE_API_TOKEN: bindings.secret(),
			CLOUDFLARE_ACCOUNT_ID: bindings.secret(),
			PiAgent: bindings.durableObject({
				worker: "durable-pi-object",
				exportName: "PiAgent",
			}),
			LOADER: bindings.workerLoader(),
		},
		exports: {
			PiAgent: exports.durableObject({
				storage: "sqlite",
			}),
		},
	},
});
