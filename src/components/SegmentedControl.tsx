import { cn } from "#/lib/utils";

/**
 * Full-width segmented toggle. Buttons split the width evenly and wrap onto extra rows when there
 * are too many to fit (so it stays usable on a phone). Used for the leaderboard metric picker and
 * the chart metric picker.
 */
export function SegmentedControl<T extends string>({
	options,
	value,
	onChange,
	className,
}: {
	options: readonly { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex w-full flex-wrap overflow-hidden rounded-md border text-xs",
				className,
			)}
		>
			{options.map((o) => {
				const active = o.value === value;
				return (
					<button
						key={o.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(o.value)}
						className={cn(
							"flex-1 whitespace-nowrap px-3 py-1.5 text-center",
							active
								? "bg-foreground text-background"
								: "text-muted-foreground hover:bg-muted",
						)}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}
