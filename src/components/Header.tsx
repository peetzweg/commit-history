import { Link } from "@tanstack/react-router";

// Dark top bar, a homage to star-history.com's header (#363636 / light text).
export function Header() {
	return (
		<header className="flex h-14 w-full shrink-0 flex-row items-center justify-between bg-foreground px-4 text-[#f5f5f5]">
			<div className="flex h-full flex-row items-center">
				<Link to="/" className="header-link gap-2 font-semibold">
					<span className="text-lg">📈</span>
					<span>Commit History</span>
				</Link>
			</div>
			<div className="flex h-full flex-row items-center">
				<a
					href="https://github.com/star-history/star-history"
					target="_blank"
					rel="noreferrer"
					className="header-link text-sm"
					title="Inspired by star-history.com"
				>
					a homage to star-history
				</a>
			</div>
		</header>
	);
}
