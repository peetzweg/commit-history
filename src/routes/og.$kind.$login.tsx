import { createFileRoute } from "@tanstack/react-router";
import { lookupUsers } from "#/lib/commit-history";
import { developerCard, orgCard, renderPng } from "#/lib/og-card";
import { orgRankFor, resolveOrg } from "#/lib/org";

/**
 * Dynamic Open Graph card for a developer or an organization:
 *   /og/user/<login>   → avatar, name, overall + public-commits rank
 *   /og/org/<login>    → avatar, name, place on the organization leaderboard
 *
 * A pure server route (`server.handlers.GET`) that renders a 1200×630 PNG with satori + resvg
 * (see lib/og-card). Referenced from the `og:image` of the /$user route's head(). Same
 * Netlify durable-CDN caching as /embed so crawler traffic doesn't re-invoke the function.
 *
 * For a not-yet-built / errored / unknown login there is no card to draw, so we redirect to the
 * static site card — with a short cache, because "building" is a transient state that resolves
 * into a real card within seconds.
 */

/** Fetch an avatar and inline it as a data URL for satori. Best-effort — null on any failure. */
async function fetchAvatar(url: string | null): Promise<string | null> {
	if (!url) return null;
	try {
		// GitHub avatars honour `s=` for a right-sized fetch (the card renders it at 200px).
		const sep = url.includes("?") ? "&" : "?";
		const res = await fetch(`${url}${sep}s=400`);
		if (!res.ok) return null;
		const mime = res.headers.get("content-type") ?? "image/png";
		const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
		return `data:${mime};base64,${base64}`;
	} catch {
		return null;
	}
}

const PNG_HEADERS = {
	"content-type": "image/png",
	"cache-control": "public, max-age=3600, s-maxage=3600",
	// `durable` = one shared cache entry across all Netlify edge nodes (see /embed), so scraper
	// traffic stops re-invoking the render function. Netlify-only; other CDNs ignore it.
	"netlify-cdn-cache-control":
		"public, durable, s-maxage=3600, stale-while-revalidate=86400",
};

/** No card to draw (building / errored / unknown) → the static site card, cached briefly. */
function fallback(request: Request): Response {
	return new Response(null, {
		status: 302,
		headers: {
			location: new URL("/og.png", request.url).toString(),
			"cache-control": "public, max-age=60",
			"netlify-cdn-cache-control": "public, durable, s-maxage=60",
		},
	});
}

export const Route = createFileRoute("/og/$kind/$login")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { kind, login } = params;
				try {
					if (kind === "org") {
						const { org } = await resolveOrg(login);
						if (!org) return fallback(request);
						const [place, avatarDataUrl] = await Promise.all([
							orgRankFor(org.totalCommits).catch(() => null),
							fetchAvatar(org.avatarUrl),
						]);
						const png = await renderPng(
							orgCard({
								login: org.login,
								name: org.name,
								avatarDataUrl,
								place,
							}),
						);
						return new Response(new Uint8Array(png), { headers: PNG_HEADERS });
					}

					if (kind === "user") {
						const [result] = await lookupUsers([login]);
						if (!result?.history) return fallback(request);
						const { user } = result.history;
						const avatarDataUrl = await fetchAvatar(user.avatarUrl);
						const png = await renderPng(
							developerCard({
								login: user.login,
								name: user.name,
								avatarDataUrl,
								rankCommits: result.ranks.public ?? null,
							}),
						);
						return new Response(new Uint8Array(png), { headers: PNG_HEADERS });
					}

					return fallback(request);
				} catch {
					return fallback(request);
				}
			},
		},
	},
});
