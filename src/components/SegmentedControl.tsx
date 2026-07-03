import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "#/lib/utils";

/**
 * iOS-style metric picker that floats as a permanent tab bar, pinned to the bottom of the viewport.
 * It reads as one long white chip (thin border, fully rounded) with a dark thumb that slides to the
 * active option, sized to match the "Plot" button so it's chunky and touch-friendly.
 *
 * It's rendered once, at the app root (see MetricBar), so it's a single persistent element across
 * navigations: when the option set changes (e.g. "Followers" only exists on the leaderboard) the
 * pill grows/shrinks and chips animate in and out via a real layout animation, rather than being
 * replaced. The thumb is positioned in content coordinates (active chip's offsetLeft/width) so it's
 * unaffected by the horizontal scroll; the row scrolls when chips overflow, the selected chip
 * auto-centres, and gradient fades mark whichever edge still has hidden chips. Number keys 1–9 jump
 * to the Nth option (ignored while typing in inputs).
 */
export function SegmentedControl<T extends string>({
	options,
	value,
	onChange,
}: {
	options: readonly { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const btnRefs = useRef<Map<T, HTMLButtonElement | null>>(new Map());
	const [thumb, setThumb] = useState<{ left: number; width: number } | null>(
		null,
	);
	const [fades, setFades] = useState({ left: false, right: false });

	// Changes whenever the option set changes — used to re-measure the thumb without depending on the
	// (freshly-allocated-every-render) options array.
	const optionsKey = options.map((o) => o.value).join(",");

	const updateFades = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const max = el.scrollWidth - el.clientWidth;
		setFades({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
	}, []);

	const measureThumb = useCallback(() => {
		const btn = btnRefs.current.get(value);
		if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth });
	}, [value]);

	// Re-place the thumb + centre the active chip when the selection or the option set changes, and
	// refresh the fades. Centre-scroll is a no-op on desktop where nothing overflows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: optionsKey is the re-measure trigger for chip-set changes; value/measureThumb cover the rest.
	useEffect(() => {
		const el = scrollRef.current;
		const btn = btnRefs.current.get(value);
		if (!el || !btn) return;
		measureThumb();
		const target = btn.offsetLeft - (el.clientWidth - btn.offsetWidth) / 2;
		el.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
		updateFades();
	}, [value, optionsKey, measureThumb, updateFades]);

	// Keep the thumb + fades honest as the viewport resizes (chips reflow; fits ⇄ overflows).
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const ro = new ResizeObserver(() => {
			measureThumb();
			updateFades();
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [measureThumb, updateFades]);

	// Number-key shortcuts (1..N). Latest options/onChange live in refs so the listener is bound once
	// and never goes stale, even though the parent passes fresh arrays each render.
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const t = e.target as HTMLElement | null;
			if (
				t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable)
			)
				return;
			const n = Number(e.key);
			const opts = optionsRef.current;
			if (!Number.isInteger(n) || n < 1 || n > opts.length) return;
			e.preventDefault();
			onChangeRef.current(opts[n - 1].value);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const spring = { type: "spring", stiffness: 500, damping: 40 } as const;

	// Fade the scroll content itself (via a mask) at whichever edge still has hidden chips, rather
	// than laying a white gradient over it — that dissolves the chips (thumb included) cleanly into
	// the pill with no seam or stray dark edge.
	const FADE = "2.5rem";
	const maskImage =
		fades.left && fades.right
			? `linear-gradient(to right, transparent, #000 ${FADE}, #000 calc(100% - ${FADE}), transparent)`
			: fades.left
				? `linear-gradient(to right, transparent, #000 ${FADE})`
				: fades.right
					? `linear-gradient(to right, #000 calc(100% - ${FADE}), transparent)`
					: undefined;

	return (
		// Positioning layer: pinned to the bottom, centered, side padding so it never touches the
		// screen edges on a phone. No entrance animation — it just appears (the pill's `layout`
		// handles the grow/shrink morph across navigations).
		<div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
			{/* layout animates the pill's width as chips come and go; overflow-hidden clips the
			    scrolling content (and the thumb) to the rounded shape. layoutDependency pins the
			    animation to the option set ONLY — without it, motion re-projects on every render
			    (this bar re-renders on every navigation) and springs any transient reflow into a
			    vertical bounce. Scoped this way, an unchanged chip set across a navigation animates
			    nothing; a changed one morphs its width. */}
			<motion.div
				layout
				layoutDependency={optionsKey}
				transition={spring}
				className="relative flex min-w-0 max-w-full overflow-hidden rounded-full border bg-background shadow-lg"
			>
				<div
					ref={scrollRef}
					onScroll={updateFades}
					style={{ maskImage, WebkitMaskImage: maskImage }}
					className="relative flex min-w-0 items-stretch gap-1 overflow-x-auto p-1 text-sm [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				>
					{thumb && (
						<motion.div
							aria-hidden
							className="absolute top-1 bottom-1 left-0 z-0 rounded-full bg-primary"
							initial={false}
							animate={{ x: thumb.left, width: thumb.width }}
							transition={spring}
						/>
					)}
					{options.map((o) => {
						const active = o.value === value;
						return (
							<motion.button
								key={o.value}
								ref={(node: HTMLButtonElement | null) => {
									btnRefs.current.set(o.value, node);
								}}
								layout
								layoutDependency={optionsKey}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={spring}
								type="button"
								aria-pressed={active}
								onClick={() => onChange(o.value)}
								// shrink-0 keeps chips at their natural width so they overflow into a
								// horizontal scroll instead of squashing. py-2.5 on mobile nudges the bar
								// closer to iOS tab-bar height; py-2 on desktop matches the Plot button.
								// Active text is white over the thumb, but stays dark until the thumb is
								// measured (avoids a white-on-white flash on first paint).
								className={cn(
									"relative z-10 shrink-0 whitespace-nowrap rounded-full px-4 py-2.5 text-center transition-colors sm:py-2",
									active
										? thumb
											? "text-primary-foreground"
											: "font-medium text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{o.label}
							</motion.button>
						);
					})}
				</div>
			</motion.div>
		</div>
	);
}
