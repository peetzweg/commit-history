/**
 * Per-IP token-bucket rate limiter for the server-function RPC endpoints.
 *
 * Server functions are public GET endpoints: every call burns GITHUB_TOKEN quota and
 * writes lookups into the shared prod DB, so a curl loop can drain the token and game
 * the leaderboard. The app runs as a single long-lived Node process on Coolify, which
 * is what makes a plain in-memory Map sufficient — no Redis, no cross-instance state.
 *
 * Kept free of TanStack imports so the bucket math is unit-testable with a fake clock.
 */

interface Bucket {
	/** Fractional tokens remaining; refills continuously up to `capacity`. */
	tokens: number;
	/** Epoch ms of the last take() — refill is computed lazily from this. */
	last: number;
}

export interface RateLimiterOptions {
	/** Burst size: calls allowed instantly from a fresh IP. */
	capacity: number;
	/** Sustained rate — tokens regained per second. */
	refillPerSecond: number;
	/**
	 * Prune trigger. The Map grows one entry per distinct client IP; past this size
	 * every take() first drops buckets that have fully refilled (they are
	 * indistinguishable from fresh ones, so forgetting them changes nothing).
	 */
	maxBuckets?: number;
	/** Injectable clock for tests. */
	now?: () => number;
}

export type TakeResult =
	| { ok: true }
	| { ok: false; retryAfterSeconds: number };

export function createRateLimiter(opts: RateLimiterOptions) {
	const { capacity, refillPerSecond, maxBuckets = 10_000 } = opts;
	const clock = opts.now ?? Date.now;
	const buckets = new Map<string, Bucket>();

	function prune(now: number) {
		for (const [key, b] of buckets) {
			const refilled = b.tokens + ((now - b.last) / 1000) * refillPerSecond;
			if (refilled >= capacity) buckets.delete(key);
		}
	}

	function take(key: string): TakeResult {
		const now = clock();
		if (buckets.size >= maxBuckets) prune(now);
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			bucket = { tokens: capacity, last: now };
			buckets.set(key, bucket);
		} else {
			const elapsedSeconds = (now - bucket.last) / 1000;
			bucket.tokens = Math.min(
				capacity,
				bucket.tokens + elapsedSeconds * refillPerSecond,
			);
			bucket.last = now;
		}
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return { ok: true };
		}
		return {
			ok: false,
			retryAfterSeconds: Math.ceil((1 - bucket.tokens) / refillPerSecond),
		};
	}

	return { take, size: () => buckets.size };
}

/**
 * Client IP for bucket keying. Prod traffic arrives Cloudflare → Traefik → app, so:
 *
 * - CF-Connecting-IP is the real visitor on every proxied request. Without it the
 *   last X-Forwarded-For hop would be a Cloudflare edge IP and ALL users would pile
 *   into a handful of buckets — instant false 429s.
 * - The fallback is the LAST X-Forwarded-For entry: Traefik APPENDS the connecting
 *   peer to any client-supplied list, so earlier entries are attacker-controlled.
 *   This covers unproxied paths (preview subdomains, direct origin hits).
 *
 * Caveat until the planned Cloudflare-IP origin lockdown (devops#2) lands: whoever
 * hits the origin directly can spoof CF-Connecting-IP and hop between buckets. That
 * weakens the ceiling for a determined attacker but never mis-buckets legit users,
 * and is strictly better than today's no-limit.
 *
 * Dev serves without a proxy, so no headers exist — every request shares one bucket,
 * which is fine locally.
 */
export function clientIpFrom(headers: Headers): string {
	const cloudflare = headers.get("cf-connecting-ip")?.trim();
	if (cloudflare) return cloudflare;
	const forwarded = headers.get("x-forwarded-for");
	if (!forwarded) return "local";
	const hops = forwarded.split(",");
	return hops[hops.length - 1]?.trim() || "local";
}
