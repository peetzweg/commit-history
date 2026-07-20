import { Link } from "@tanstack/react-router";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { Person } from "#/components/Person";
import { RankBoard } from "#/components/RankBoard";

/**
 * Element overrides passed to every rendered MDX article.
 * Styling comes from the `prose` wrapper (@tailwindcss/typography) — overrides here are
 * only for behavior: internal links SPA-navigate, external links open in a new tab.
 */
function MdxAnchor({ href = "", children, ...rest }: ComponentProps<"a">) {
	if (href.startsWith("/")) {
		// Links with a query string (e.g. /?metric=followers) can't ride the typed router
		// `to` (it treats the whole string as a path) — let the browser navigate those.
		if (href.includes("?")) {
			return (
				<a href={href} {...rest}>
					{children}
				</a>
			);
		}
		// Author-supplied path, not a statically-known route — bypass typed routing.
		return (
			<Link to={href as never} {...rest}>
				{children}
			</Link>
		);
	}
	return (
		<a href={href} target="_blank" rel="noopener" {...rest}>
			{children}
		</a>
	);
}

/** Article images (e.g. the /embed charts in ranking articles) load lazily — a listicle can
 *  carry ten of them, and none should compete with the text for bandwidth. The embed charts are
 *  a fixed 800×400 SVG, so declare those intrinsic dimensions: the browser then reserves the
 *  aspect ratio up front and the page doesn't shift as the charts stream in (avoids CLS). */
function MdxImage({ alt = "", src, ...rest }: ComponentProps<"img">) {
	const isChart = typeof src === "string" && src.includes("/embed/");
	return (
		<img
			src={src}
			alt={alt}
			loading="lazy"
			decoding="async"
			{...(isChart
				? { width: 800, height: 400, className: "h-auto w-full" }
				: {})}
			{...rest}
		/>
	);
}

export const mdxComponents: MDXComponents = {
	a: MdxAnchor,
	img: MdxImage,
	// Custom blocks available to posts: the per-developer profile header and the styled
	// leaderboard that opens each ranking article (mirrors the homepage board).
	Person,
	RankBoard,
};
