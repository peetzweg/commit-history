import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/")({
	head: () => ({
		links: [{ rel: "canonical", href: "https://commit-history.com/" }],
	}),
	component: Home,
});

function Home() {
	const navigate = useNavigate();
	const [login, setLogin] = useState("");

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const user = login.trim();
		if (user) navigate({ to: "/$user", params: { user } });
	}

	return (
		<main className="mx-auto flex min-h-[calc(100svh-3.5rem)] max-w-xl flex-col justify-center px-6">
			<h1 className="text-center text-5xl font-bold tracking-tight">
				Commit History
			</h1>
			<p className="mt-4 text-center text-lg text-muted-foreground">
				A <span className="accent-text font-medium">star-history</span>, but for
				a GitHub user’s cumulative commits over their whole lifetime.
			</p>

			<form onSubmit={submit} className="mt-10 flex items-stretch gap-2">
				<div className="flex flex-1 items-center rounded-md border shadow-inner focus-within:shadow-[0_0_0_0.125em_var(--ring)]">
					<span className="pl-3 text-muted-foreground">github.com/</span>
					<input
						// biome-ignore lint/a11y/noAutofocus: single-purpose landing page; focusing the one input is the intent
						autoFocus
						value={login}
						onChange={(e) => setLogin(e.target.value)}
						placeholder="peetzweg"
						aria-label="GitHub username"
						className="flex-1 bg-transparent p-2 pl-1 outline-none"
					/>
				</div>
				<button type="submit" className="btn-primary">
					Plot
				</button>
			</form>

			<div className="mt-6 flex justify-center gap-3 text-sm text-muted-foreground">
				<span>Try:</span>
				{["peetzweg", "torvalds", "gaearon"].map((u) => (
					<button
						key={u}
						type="button"
						onClick={() => navigate({ to: "/$user", params: { user: u } })}
						className="accent-text hover:underline"
					>
						{u}
					</button>
				))}
			</div>
		</main>
	);
}
