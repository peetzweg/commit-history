import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

const SITE = "https://commit-history.com";

export const Route = createFileRoute("/-/embed/$user")({
	component: EmbedPage,
});

function EmbedPage() {
	const { user } = Route.useParams();
	const [copied, setCopied] = useState(false);
	const snippet = embedSnippet(user);

	async function copy() {
		try {
			await navigator.clipboard.writeText(snippet);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard unavailable */
		}
	}

	return (
		<main className="mx-auto max-w-2xl px-6 py-12 sm:py-16">
			<Link
				to="/$user"
				params={{ user }}
				className="text-sm text-muted-foreground hover:text-foreground"
			>
				← Back to {user}'s commit history
			</Link>
			<h1 className="mt-8 text-2xl font-bold tracking-tight">
				Embed {user}'s commit history
			</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				Add a live chart to your GitHub profile README or any project README. It
				updates over time and switches between light and dark to match the
				viewer’s GitHub theme.
			</p>

			{/* A static screenshot avoids rendering a second live chart and making an
			   extra embed request on every visit to this instructions page. */}
			<figure className="mt-8">
				<a
					href="https://github.com/peetzweg"
					target="_blank"
					rel="noopener"
					className="block overflow-hidden rounded-xl border border-border"
				>
					<img
						src="/embed-example.png"
						alt="A commit-history chart embedded in a GitHub profile README"
						className="w-full"
					/>
				</a>
				<figcaption className="mt-2 text-xs text-muted-foreground">
					How it looks on a GitHub profile.
				</figcaption>
			</figure>

			<div className="group relative mt-6">
				<pre className="overflow-x-auto rounded-md border bg-muted py-2.5 pl-3 pr-20 text-xs leading-relaxed">
					<code>{snippet}</code>
				</pre>
				<button
					type="button"
					onClick={copy}
					className="absolute right-2 top-2 rounded-md border bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground backdrop-blur transition-colors hover:bg-background hover:text-foreground"
				>
					{copied ? "Copied!" : "Copy"}
				</button>
			</div>
		</main>
	);
}

/** The exact markup to paste into a GitHub profile or README. */
function embedSnippet(login: string): string {
	const page = `${SITE}/${login}`;
	const img = `${SITE}/embed/${login}`;
	const alt = `${login}'s commit history`;
	return `<div align="center">
  <a href="${page}">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="${img}?theme=dark" />
      <img alt="${alt}" src="${img}" />
    </picture>
  </a>
</div>`;
}
