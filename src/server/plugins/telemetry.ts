import { definePlugin } from "nitro";
import { telemetryConfigured } from "#/lib/telemetry";

/**
 * Starts OTLP metrics export for the web server (#202). Registered in `vite.config.ts`; a Nitro
 * plugin runs once at server boot, outside the client bundle, which is what keeps the Node-only
 * backend out of the browser. The SDK is only loaded when an OTLP endpoint is configured, so
 * local dev, tests and unconfigured previews never pay for it.
 */
export default definePlugin((nitroApp) => {
	if (!telemetryConfigured(process.env)) return;
	const telemetry = import("#/lib/telemetry-node")
		.then(({ startTelemetry }) =>
			startTelemetry({
				serviceName: "commit-history-web",
				defaultSource: "live",
			}),
		)
		.catch((error) => {
			console.warn(
				`telemetry status=start_failed error=${JSON.stringify(String(error))}`,
			);
			return null;
		});
	nitroApp.hooks.hook("close", async () => {
		await (await telemetry)?.shutdown();
	});
});
