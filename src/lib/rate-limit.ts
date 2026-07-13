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
 * Client IP as seen by our Traefik (Coolify's proxy).
 *
 * Traefik APPENDS the connecting peer to any client-supplied X-Forwarded-For, so only
 * the LAST entry is trustworthy — earlier entries are attacker-controlled and using
 * them would let one machine spread across arbitrary buckets. When the Cloudflare
 * proxy (orange cloud) is enabled later, the last hop becomes Cloudflare's IP and this
 * must switch to reading the entry Cloudflare appended (or CF-Connecting-IP, which is
 * only trustworthy once CF is guaranteed to be in front).
 *
 * Dev serves without a proxy, so no header exists — every request shares one bucket,
 * which is fine locally.
 */
export function clientIpFrom(headers: Headers): string {
	const forwarded = headers.get("x-forwarded-for");
	if (!forwarded) return "local";
	const hops = forwarded.split(",");
	return hops[hops.length - 1]?.trim() || "local";
}
