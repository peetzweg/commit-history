import { Link } from "@tanstack/react-router";

/**
 * Router-wide 404, shown for any unmatched route (wired as `defaultNotFoundComponent` in
 * router.tsx). Deliberately minimal for now — a plain, on-brand fallback to replace TanStack's
 * generic `<p>Not Found</p>`. Refine into something fun later.
 */
export function NotFound() {
	return (
		<main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 py-24 text-center">
			<p className="text-6xl font-bold tracking-tight">404</p>
			<h1 className="mt-4 text-xl font-semibold">Page not found</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				That page doesn’t exist. Try looking up a GitHub user instead.
			</p>
			<Link to="/" className="btn-primary mt-6">
				Back to commit-history
			</Link>
		</main>
	);
}
