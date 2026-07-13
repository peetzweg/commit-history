import {
	createCsrfMiddleware,
	createMiddleware,
	createStart,
} from "@tanstack/react-start";
import { clientIpFrom, createRateLimiter } from "#/lib/rate-limit";

/**
 * Guards against scripted abuse of the server-function RPC endpoints (they burn
 * GITHUB_TOKEN quota and write lookups into prod — see rate-limit.ts).
 *
 * IMPORTANT: the moment this file exists, TanStack Start hands the whole request
 * middleware chain to us and stops injecting its default CSRF middleware — so the
 * same-origin check below is not optional hardening, it re-applies protection the
 * framework was providing implicitly before.
 */

/**
 * Same-origin check: server functions are only ever called by our own frontend, so a
 * request with no browser-origin evidence (Sec-Fetch-Site / Origin / Referer) or with
 * a foreign origin gets a 403. Kills naive curl/scripting; both checks apply only to
 * `serverFn` requests so SSR page loads (Googlebot included) stay untouched.
 */
const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

// ~5 RPC calls per client-side navigation → a human browsing hard stays inside the
// burst; a lookup loop flattens to 20/min. First SSR page load doesn't count (server
// functions run in-process there, handlerType "router").
const limiter = createRateLimiter({ capacity: 40, refillPerSecond: 20 / 60 });

const rateLimitMiddleware = createMiddleware({ type: "request" }).server(
	({ request, next, handlerType }) => {
		if (handlerType !== "serverFn") return next();
		const result = limiter.take(clientIpFrom(request.headers));
		if (!result.ok) {
			return new Response("Too Many Requests", {
				status: 429,
				headers: { "Retry-After": String(result.retryAfterSeconds) },
			});
		}
		return next();
	},
);

export const startInstance = createStart(() => ({
	requestMiddleware: [csrfMiddleware, rateLimitMiddleware],
}));
