declare module "*.mdx" {
	import type { MDXComponents } from "mdx/types";
	import type { ComponentType } from "react";

	/** Parsed YAML frontmatter, exported by remark-mdx-frontmatter. */
	export const frontmatter: {
		title: string;
		description: string;
		publishedAt: string;
		updatedAt: string;
		order?: number;
	};

	const MDXContent: ComponentType<{ components?: MDXComponents }>;
	export default MDXContent;
}
