import { Link } from "@tanstack/react-router";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";

/**
 * Element overrides passed to every rendered MDX article.
 * Styling comes from the `prose` wrapper (@tailwindcss/typography) — overrides here are
 * only for behavior: internal links SPA-navigate, external links open in a new tab.
 */
function MdxAnchor({ href = "", children, ...rest }: ComponentProps<"a">) {
	if (href.startsWith("/")) {
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

export const mdxComponents: MDXComponents = {
	a: MdxAnchor,
};
