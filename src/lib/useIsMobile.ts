import { useSyncExternalStore } from "react";

// Tailwind's `sm` breakpoint. Below this we treat the viewport as a phone and grow the
// chart's labels + padding so they stay legible once the fixed-viewBox SVG is squeezed
// into a narrow container.
const MOBILE_QUERY = "(max-width: 639px)";

function subscribe(onChange: () => void) {
	const mql = window.matchMedia(MOBILE_QUERY);
	mql.addEventListener("change", onChange);
	return () => mql.removeEventListener("change", onChange);
}

/** True when the viewport is phone-width. SSR renders the desktop layout (getServerSnapshot
 *  returns false); the client corrects on hydration. */
export function useIsMobile() {
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia(MOBILE_QUERY).matches,
		() => false,
	);
}
