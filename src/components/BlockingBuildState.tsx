import { type ReactNode, useId } from "react";

export interface BuildProgressItem {
	login: string;
	fetched: number;
	total: number;
	unit: "months" | "members";
}

export function BlockingBuildState({
	children,
	items,
	title,
	description,
}: {
	children: ReactNode;
	items: BuildProgressItem[];
	title: string;
	description: string;
}) {
	const titleId = useId();
	const descriptionId = useId();

	return (
		<>
			<div
				inert
				aria-hidden="true"
				className="pointer-events-none select-none opacity-40 blur-[1px]"
			>
				{children}
			</div>
			<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/55 px-6 backdrop-blur-[2px]">
				<div
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
					aria-describedby={descriptionId}
					className="w-[calc(100vw-3rem)] max-w-md rounded-xl border border-border bg-background p-5 shadow-xl"
				>
					<h2 id={titleId} className="text-base font-semibold">
						{title}
					</h2>
					<p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
						{description}
					</p>

					<div className="mt-5 grid gap-4">
						{items.map((item) => {
							const pct =
								item.total > 0
									? Math.min(100, Math.round((item.fetched / item.total) * 100))
									: 0;
							return (
								<div key={item.login}>
									<div className="flex items-baseline justify-between gap-4 text-sm">
										<span className="font-medium">@{item.login}</span>
										<span className="text-xs tabular-nums text-muted-foreground">
											{pct}%
										</span>
									</div>
									<div
										className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
										role="progressbar"
										aria-valuenow={pct}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-label={`Fetching ${item.login}'s ${item.unit}`}
									>
										<div
											className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
											style={{ width: `${pct}%` }}
										/>
									</div>
									<p
										className="mt-2 text-xs tabular-nums text-muted-foreground"
										aria-live="polite"
									>
										{item.fetched.toLocaleString()} of{" "}
										{item.total.toLocaleString()} {item.unit} fetched
									</p>
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</>
	);
}
