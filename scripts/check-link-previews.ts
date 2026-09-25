/**
 * Guard for social link previews: fetch prod pages the way X, Facebook, Discord and Slack do and
 * fail if any of them would get a broken card. The 2026-09 outage was Cloudflare Bot Fight Mode
 * serving a managed challenge to unfurlers on datacenter IPs, so the pages were fine and nothing
 * in the repo changed. Run it from a datacenter IP (the scheduled GitHub Action) to catch that;
 * from a residential IP it proves much less.
 *
 *   node scripts/check-link-previews.ts [--base https://commit-history.com]
 *
 * Exits non-zero listing every failed (path, user agent) pair.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		base: {
			type: "string",
			default: process.env.PREVIEW_CHECK_BASE ?? "https://commit-history.com",
		},
	},
});
const base = values.base.replace(/\/$/, "");

const PATHS = ["/", "/torvalds?metric=total"];
const USER_AGENTS = {
	x: "Twitterbot/1.0",
	facebook:
		"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
	discord:
		"Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
	slack: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
	// Unfurlers following t.co links send plain browser UAs; Bot Fight Mode challenged these too.
	browser:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
const TIMEOUT_MS = 15_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function metaContent(html: string, key: string): string | undefined {
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		const name = tag.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1];
		if (name !== key) continue;
		return tag
			.match(/\bcontent=["']([^"']*)["']/i)?.[1]
			?.replaceAll("&amp;", "&");
	}
	return undefined;
}

async function get(url: string, userAgent: string): Promise<Response> {
	return fetch(url, {
		headers: { "user-agent": userAgent },
		redirect: "follow",
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
}

function challengeReason(res: Response): string | undefined {
	const mitigated = res.headers.get("cf-mitigated");
	if (mitigated) return `Cloudflare cf-mitigated: ${mitigated}`;
	if (res.status === 403 || res.status === 503)
		return `HTTP ${res.status} (likely an edge block/challenge)`;
	return undefined;
}

async function checkImage(url: string, userAgent: string): Promise<string[]> {
	const res = await get(url, userAgent);
	const challenge = challengeReason(res);
	if (challenge) return [`og:image ${url}: ${challenge}`];
	if (!res.ok) return [`og:image ${url}: HTTP ${res.status}`];
	const type = res.headers.get("content-type") ?? "";
	if (!type.startsWith("image/png"))
		return [`og:image ${url}: content-type ${type || "(none)"}`];
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b))
		return [`og:image ${url}: body is not a PNG`];
	// IHDR is always the first chunk: width/height are big-endian u32 at bytes 16 and 20.
	const view = new DataView(bytes.buffer, bytes.byteOffset);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (width !== 1200 || height !== 630)
		return [`og:image ${url}: ${width}x${height}, expected 1200x630`];
	return [];
}

async function checkPage(path: string, userAgent: string): Promise<string[]> {
	const res = await get(`${base}${path}`, userAgent);
	const challenge = challengeReason(res);
	if (challenge) return [challenge];
	if (!res.ok) return [`HTTP ${res.status}`];
	const html = await res.text();
	const failures: string[] = [];
	const ogImage = metaContent(html, "og:image");
	for (const key of ["og:title", "og:image", "twitter:card", "twitter:image"]) {
		if (!metaContent(html, key)) failures.push(`missing <meta ${key}>`);
	}
	if (ogImage) failures.push(...(await checkImage(ogImage, userAgent)));
	return failures;
}

const failed: string[] = [];
let checked = 0;
for (const path of PATHS) {
	for (const [agent, userAgent] of Object.entries(USER_AGENTS)) {
		checked++;
		let failures: string[];
		try {
			failures = await checkPage(path, userAgent);
		} catch (err) {
			failures = [err instanceof Error ? err.message : String(err)];
		}
		const label = `${path} as ${agent}`;
		if (failures.length === 0) {
			console.log(`ok    ${label}`);
		} else {
			for (const f of failures) failed.push(`${label}: ${f}`);
			console.log(`FAIL  ${label}\n      ${failures.join("\n      ")}`);
		}
	}
}

console.log(
	`link-previews done status=${failed.length ? "failed" : "ok"} checked=${checked} failed=${failed.length} base=${base}`,
);
if (failed.length) process.exit(1);
