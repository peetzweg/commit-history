declare module "*.mdx" {
	import type { ComponentType } from "react";
	import type { MDXComponents } from "mdx/types";

	/** Parsed YAML frontmatter, exported by remark-mdx-frontmatter. */
	export const frontmatter: {
		title: string;
		description: string;
		publishedAt: string;
		updatedAt: string;
	};

	const MDXContent: ComponentType<{ components?: MDXComponents }>;
	export default MDXContent;
}
