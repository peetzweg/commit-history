import { useState } from "react";
import { fmt } from "#/lib/repo-format";

// Same accent as CommitChart so a repo page reads as part of the same site.
const ACCENT = "#16a34a";
const W = 640;
const H = 120;
const PAD_TOP = 8;

function monthName(label: string) {
	return new Date(`${label}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	});
}

/**
 * One monthly series as bars — a small multiple on the repo page. Single series, so no legend: the
 * title names it. Hovering (or focusing) a month shows its exact value in the header readout; a
 * collapsed table carries the same numbers for screen readers and copy-paste.
 */
export function RepoMonthlyBars({
	title,
	points,
	note,
}: {
	title: string;
	points: Array<{ month: string; value: number | null }>;
	note?: string;
}) {
	const [active, setActive] = useState<number | null>(null);
	const known = points.filter((p) => p.value != null);
	if (!known.length) {
		return (
			<figure className="rounded-xl border border-border p-4">
				<figcaption className="text-sm font-medium">{title}</figcaption>
				<p className="mt-2 text-sm text-muted-foreground">
					{note ?? "Not measured yet."}
				</p>
			</figure>
		);
	}
	const max = Math.max(1, ...known.map((p) => p.value ?? 0));
	const step = W / points.length;
	const gap = step > 4 ? 1 : 0;
	const hovered = active != null ? points[active] : null;
	const total = known.reduce((s, p) => s + (p.value ?? 0), 0);

	return (
		<figure className="rounded-xl border border-border p-4">
			<figcaption className="flex items-baseline justify-between gap-3 text-sm">
				<span className="font-medium">{title}</span>
				<span className="tabular-nums text-muted-foreground">
					{hovered
						? `${monthName(hovered.month)}: ${fmt(hovered.value)}`
						: `${fmt(total)} total · peak ${fmt(max)}`}
				</span>
			</figcaption>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="mt-3 h-28 w-full"
				preserveAspectRatio="none"
				role="img"
				aria-label={`${title}, monthly, ${monthName(points[0].month)} to ${monthName(points[points.length - 1].month)}`}
				onPointerMove={(e) => {
					// One handler for the whole plot: every month's column is its hit target, far
					// wider than a thin bar.
					const box = e.currentTarget.getBoundingClientRect();
					const i = Math.floor(
						((e.clientX - box.left) / box.width) * points.length,
					);
					setActive(Math.min(points.length - 1, Math.max(0, i)));
				}}
				onPointerLeave={() => setActive(null)}
			>
				<line
					x1={0}
					x2={W}
					y1={H}
					y2={H}
					stroke="currentColor"
					opacity={0.15}
				/>
				{points.map((p, i) => {
					const h = p.value ? ((H - PAD_TOP) * p.value) / max : 0;
					return (
						<rect
							key={p.month}
							x={i * step + gap / 2}
							y={H - h}
							width={Math.max(step - gap, 0.5)}
							height={h}
							rx={Math.min(2, (step - gap) / 2)}
							fill={ACCENT}
							opacity={active == null || active === i ? 1 : 0.45}
						/>
					);
				})}
			</svg>
			<div className="mt-1 flex justify-between text-xs text-muted-foreground">
				<span>{monthName(points[0].month)}</span>
				<span>{monthName(points[points.length - 1].month)}</span>
			</div>
			{note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
			<details className="mt-2 text-xs text-muted-foreground">
				<summary className="cursor-pointer">Table</summary>
				<table className="mt-2 w-full tabular-nums">
					<tbody>
						{[...points].reverse().map((p) => (
							<tr key={p.month}>
								<td>{monthName(p.month)}</td>
								<td className="text-right">{fmt(p.value)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</figure>
	);
}
