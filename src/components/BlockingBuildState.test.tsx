// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockingBuildState } from "#/components/BlockingBuildState";

describe("BlockingBuildState", () => {
	it("disables the page and presents progress in a centered modal dialog", () => {
		const { container, unmount } = render(
			<BlockingBuildState
				items={[
					{
						login: "new-user",
						fetched: 3,
						total: 12,
						unit: "months",
					},
				]}
				title="Fetching user data…"
				description="This can take a moment on a first lookup."
			>
				<main>Existing page</main>
			</BlockingBuildState>,
		);

		const background = screen.getByText("Existing page").closest("[inert]");
		expect(background?.getAttribute("aria-hidden")).toBe("true");
		expect(background?.hasAttribute("inert")).toBe(true);

		const dialog = screen.getByRole("dialog", { name: "Fetching user data…" });
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(dialog.parentElement?.className).toContain("fixed");
		expect(dialog.parentElement?.className).toContain("inset-0");
		expect(dialog.parentElement?.className).toContain("items-center");
		expect(dialog.parentElement?.className).toContain("justify-center");
		expect(dialog.className).toContain("w-[calc(100vw-3rem)]");
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
			"25",
		);
		expect(screen.queryByRole("button")).toBeNull();
		expect(container.textContent).toContain("3 of 12 months fetched");
		expect(document.documentElement.style.overflow).toBe("hidden");
		expect(document.body.style.overflow).toBe("hidden");

		unmount();
		expect(document.documentElement.style.overflow).toBe("");
		expect(document.body.style.overflow).toBe("");
	});
});
