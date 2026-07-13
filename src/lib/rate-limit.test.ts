import { describe, expect, it } from "vitest";
import { clientIpFrom, createRateLimiter } from "#/lib/rate-limit";

/** Manually advanced clock so refill math is exact and tests never sleep. */
const fakeClock = () => {
	let ms = 0;
	return {
		now: () => ms,
		advanceSeconds: (s: number) => {
			ms += s * 1000;
		},
	};
};

describe("createRateLimiter", () => {
	it("allows a full burst, then rejects", () => {
		const clock = fakeClock();
		const limiter = createRateLimiter({
			capacity: 3,
			refillPerSecond: 1,
			now: clock.now,
		});
		expect(limiter.take("ip")).toEqual({ ok: true });
		expect(limiter.take("ip")).toEqual({ ok: true });
		expect(limiter.take("ip")).toEqual({ ok: true });
		expect(limiter.take("ip").ok).toBe(false);
	});

	it("refills over time and tells the caller when to retry", () => {
		const clock = fakeClock();
		const limiter = createRateLimiter({
			capacity: 2,
			refillPerSecond: 0.5, // one token every 2s
			now: clock.now,
		});
		limiter.take("ip");
		limiter.take("ip");
		const rejected = limiter.take("ip");
		expect(rejected).toEqual({ ok: false, retryAfterSeconds: 2 });
		clock.advanceSeconds(2);
		expect(limiter.take("ip")).toEqual({ ok: true });
	});

	it("never refills past capacity", () => {
		const clock = fakeClock();
		const limiter = createRateLimiter({
			capacity: 2,
			refillPerSecond: 1,
			now: clock.now,
		});
		clock.advanceSeconds(60); // long idle must not bank 60 tokens
		limiter.take("ip");
		limiter.take("ip");
		expect(limiter.take("ip").ok).toBe(false);
	});

	it("tracks each key independently", () => {
		const clock = fakeClock();
		const limiter = createRateLimiter({
			capacity: 1,
			refillPerSecond: 1,
			now: clock.now,
		});
		expect(limiter.take("a")).toEqual({ ok: true });
		expect(limiter.take("a").ok).toBe(false);
		expect(limiter.take("b")).toEqual({ ok: true });
	});

	it("prunes fully-refilled buckets instead of growing forever", () => {
		const clock = fakeClock();
		const limiter = createRateLimiter({
			capacity: 1,
			refillPerSecond: 1,
			maxBuckets: 3,
			now: clock.now,
		});
		limiter.take("a");
		limiter.take("b");
		limiter.take("c");
		clock.advanceSeconds(10); // everyone refilled → all forgettable
		limiter.take("d");
		expect(limiter.size()).toBe(1);
	});

	it("keeps still-draining buckets when pruning", () => {
		const clock = fakeClock();
		const limiter = createRateLimiter({
			capacity: 5,
			refillPerSecond: 0.01, // refills far slower than the test advances
			maxBuckets: 2,
			now: clock.now,
		});
		limiter.take("hot"); // 4 tokens left, nowhere near refilled
		limiter.take("cold");
		clock.advanceSeconds(1);
		limiter.take("new"); // triggers prune; "hot" and "cold" must survive
		expect(limiter.size()).toBe(3);
		expect(limiter.take("hot").ok).toBe(true);
	});
});

describe("clientIpFrom", () => {
	const headers = (xff?: string) =>
		new Headers(xff === undefined ? {} : { "x-forwarded-for": xff });

	it("takes the last hop — the one Traefik appended", () => {
		expect(clientIpFrom(headers("203.0.113.7"))).toBe("203.0.113.7");
		// Earlier entries are client-supplied and must not shift the bucket key.
		expect(clientIpFrom(headers("1.1.1.1, 2.2.2.2, 203.0.113.7"))).toBe(
			"203.0.113.7",
		);
	});

	it("falls back to a shared bucket without a proxy (dev)", () => {
		expect(clientIpFrom(headers())).toBe("local");
		expect(clientIpFrom(headers("  "))).toBe("local");
	});
});
