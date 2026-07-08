import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

// ── Build polling: keep an in-progress server-side build moving ───────────────
// Extracted from $user.tsx so the org route can reuse it — the server contract is identical
// (503-with-progress → the client re-runs the loader until the build completes).

const BUILD_POLL_MS = 3_000;
const BUILD_POLL_TIMEOUT_MS = 5 * 60_000;
// Consecutive polls with no progress growth before giving up. Each healthy poll fetches a
// chunk or more, so this many stalls means something is genuinely stuck (quota, DB writes).
const BUILD_MAX_STALLED_POLLS = 5;

/**
 * While a build is in progress, re-run a route's loader every few seconds — each run advances
 * the build server-side (there are no background workers; requests ARE the worker). Polls chain
 * off loader-data identity (`data`), so they never overlap: period ≈ loader time + delay.
 * `router.invalidate` keeps the current view rendered (no pending flash) and keeps loaderData
 * the single source of truth.
 */
export function useBuildPolling({
	routeId,
	resetKey,
	data,
	building,
	fetched,
}: {
	/** Route whose loader to invalidate, e.g. "/$user". */
	routeId: string;
	/** A different value = a fresh polling session (typically the route param). */
	resetKey: string;
	/** The loader data itself — a new identity per load re-arms the poll timer. */
	data: unknown;
	/** Whether any build is still in flight. */
	building: boolean;
	/** Total progress units fetched so far — drives stall detection. */
	fetched: number;
}) {
	const router = useRouter();
	const [gaveUp, setGaveUp] = useState(false);
	const startedAt = useRef<number | null>(null);
	const lastFetched = useRef(-1);
	const stalls = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset exactly when the key changes
	useEffect(() => {
		startedAt.current = null;
		lastFetched.current = -1;
		stalls.current = 0;
		setGaveUp(false);
	}, [resetKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `data` re-arms the timer per load
	useEffect(() => {
		if (!building || gaveUp) return;
		startedAt.current ??= Date.now();
		stalls.current = fetched > lastFetched.current ? 0 : stalls.current + 1;
		lastFetched.current = fetched;
		if (
			Date.now() - startedAt.current > BUILD_POLL_TIMEOUT_MS ||
			stalls.current >= BUILD_MAX_STALLED_POLLS
		) {
			setGaveUp(true);
			return;
		}
		const t = setTimeout(() => {
			router.invalidate({ filter: (m) => m.routeId === routeId });
		}, BUILD_POLL_MS);
		return () => clearTimeout(t);
	}, [data, building, gaveUp, router, routeId]);

	const retry = () => {
		startedAt.current = null;
		lastFetched.current = -1;
		stalls.current = 0;
		setGaveUp(false);
		router.invalidate({ filter: (m) => m.routeId === routeId });
	};

	return { gaveUp, retry };
}
