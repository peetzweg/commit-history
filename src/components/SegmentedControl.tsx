import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "#/lib/utils";

// Session-scoped: the slide-up entrance plays once (first page load). On later navigations the View
// Transitions API morphs the bar across routes, so a fresh slide-up would fight that snapshot.
let hasEnteredOnce = false;

/**
 * iOS-style metric picker that floats as a permanent tab bar, pinned to the bottom of the viewport.
 * It reads as one long white chip (thin border, fully rounded) with a dark thumb that slides to the
 * active option, sized to match the "Plot" button so it's chunky and touch-friendly.
 *
 * When the chips overflow (e.g. on a phone) the row scrolls horizontally, the selected chip is
 * auto-scrolled to the centre so it's always in view, and a white gradient fades the content at
 * whichever edge still has more chips hidden behind it — a live affordance that there's more to see.
 *
 * The thumb is positioned in *content* coordinates (the active chip's offsetLeft/width) rather than
 * via a shared-layout animation. That decouples it from the horizontal scroll: centre-scrolling and
 * the thumb glide no longer fight each other (which made adjacent-tab moves stutter on mobile).
 *
 * Number keys 1–9 jump straight to the Nth option (an undocumented power-user shortcut). Used for
 * the leaderboard metric picker and the chart metric picker.
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
	const scrollRef = useRef<HTMLDivElement>(null);
	const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
	// Only animate the entrance the first time the bar mounts this session (see note above).
	const animateEntrance = useRef(!hasEnteredOnce);
	useEffect(() => {
		hasEnteredOnce = true;
	}, []);
	// Thumb geometry in the scroll content's own coordinates (unaffected by scrollLeft).
	const [thumb, setThumb] = useState<{ left: number; width: number } | null>(
		null,
	);
	// Which edges still have hidden chips — drives the fading gradients. Both false = no overflow
	// (everything fits, typically desktop), so no fades show.
	const [fades, setFades] = useState({ left: false, right: false });

	const activeIndex = options.findIndex((o) => o.value === value);

	const updateFades = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const max = el.scrollWidth - el.clientWidth;
		setFades({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
	}, []);

	const measureThumb = useCallback(() => {
		const btn = btnRefs.current[activeIndex];
		if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth });
	}, [activeIndex]);

	// On selection: re-place the thumb, centre the active chip, refresh the fades. Centre-scroll is a
	// no-op on desktop where nothing overflows (target clamps to 0, no scroll range).
	useEffect(() => {
		const el = scrollRef.current;
		const btn = btnRefs.current[activeIndex];
		if (!el || !btn) return;
		measureThumb();
		const target = btn.offsetLeft - (el.clientWidth - btn.offsetWidth) / 2;
		el.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
		updateFades();
	}, [activeIndex, measureThumb, updateFades]);

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

	return (
		<motion.div
			// Quick slide-up on the first mount so people notice the bar arrive. On later navigations
			// the View Transitions API morphs it instead, so we skip the slide (start at rest).
			initial={animateEntrance.current ? { y: 80, opacity: 0 } : false}
			animate={{ y: 0, opacity: 1 }}
			transition={{ type: "spring", stiffness: 460, damping: 34 }}
			className={cn(
				// Positioning layer: pinned to the bottom, centered, with side padding so the pill never
				// touches the screen edges on a phone.
				"fixed inset-x-0 bottom-4 z-50 flex justify-center px-4",
				className,
			)}
		>
			{/* overflow-hidden clips the scrolling content to the rounded shape so the thumb never
			    pokes past the pill's caps. The view-transition-name lets the browser morph this pill
			    across page navigations (it shrinks/grows as metrics like Followers come and go). */}
			<div className="relative flex min-w-0 max-w-full overflow-hidden rounded-full border bg-background shadow-lg [view-transition-name:metric-bar]">
				{/* Edge fades: white → transparent, shown only when that side has more chips hidden. */}
				<div
					className={cn(
						"pointer-events-none absolute inset-y-0 left-0 z-20 w-12 rounded-l-full bg-gradient-to-r from-background to-transparent transition-opacity duration-200",
						fades.left ? "opacity-100" : "opacity-0",
					)}
				/>
				<div
					className={cn(
						"pointer-events-none absolute inset-y-0 right-0 z-20 w-12 rounded-r-full bg-gradient-to-l from-background to-transparent transition-opacity duration-200",
						fades.right ? "opacity-100" : "opacity-0",
					)}
				/>
				<div
					ref={scrollRef}
					onScroll={updateFades}
					className="relative flex min-w-0 items-stretch gap-1 overflow-x-auto p-1 text-sm [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				>
					{thumb && (
						<motion.div
							aria-hidden
							className="absolute top-1 bottom-1 left-0 z-0 rounded-full bg-foreground"
							initial={false}
							animate={{ x: thumb.left, width: thumb.width }}
							transition={{ type: "spring", stiffness: 500, damping: 40 }}
						/>
					)}
					{options.map((o, i) => {
						const active = o.value === value;
						return (
							<button
								key={o.value}
								ref={(node) => {
									btnRefs.current[i] = node;
								}}
								type="button"
								aria-pressed={active}
								onClick={() => onChange(o.value)}
								// shrink-0 keeps chips at their natural width so they overflow into a horizontal
								// scroll instead of squashing. py-2.5 on mobile lifts the bar a touch closer to
								// iOS tab-bar height; py-2 on desktop keeps it matching the Plot button. Active
								// text is white over the thumb, but stays dark until the thumb is measured (avoids
								// a white-on-white flash on first paint).
								className={cn(
									"relative z-10 shrink-0 whitespace-nowrap rounded-full px-4 py-2.5 text-center transition-colors sm:py-2",
									active
										? thumb
											? "text-background"
											: "font-medium text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{o.label}
							</button>
						);
					})}
				</div>
			</div>
		</motion.div>
	);
}
