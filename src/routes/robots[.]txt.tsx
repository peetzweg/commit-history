import { createFileRoute } from "@tanstack/react-router";

/**
 * Host-aware robots.txt (replaces the old static public/robots.txt).
 *
 * The app answers on hostnames besides the production domain — Coolify PR previews
 * (`<pr>.next.commit-history.com`) and the bare origin IP. Crawlers found the previews and
 * farm them (each SSR page view burns GitHub quota and writes into the shared prod DB), so
 * every non-production host gets a full Disallow. Production keeps the exact policy the
 * static file had: everything allowed, sitemap advertised. A static segment outranks the
 * `$user` catch-all, so no GitHub login is shadowed except the literal "robots.txt".
 */
const PROD_HOSTS = new Set(["commit-history.com", "www.commit-history.com"]);

const ALLOW_ALL = `# https://www.robotstxt.org/robotstxt.html
User-agent: *
Allow: /

Sitemap: https://commit-history.com/sitemap.xml
`;

const DENY_ALL = `# Non-production host (PR preview) — not for crawlers.
User-agent: *
Disallow: /
`;

export const Route = createFileRoute("/robots.txt")({
	server: {
		handlers: {
			GET: ({ request }) => {
				// Host header, not URL: behind the proxies the URL host can be internal.
				const host = (request.headers.get("host") ?? "")
					.split(":")[0]
					?.toLowerCase();
				const isProd = host !== undefined && PROD_HOSTS.has(host);
				return new Response(isProd ? ALLOW_ALL : DENY_ALL, {
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"cache-control": "public, max-age=3600",
					},
				});
			},
		},
	},
});
