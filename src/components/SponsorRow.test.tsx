// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: [
			{
				id: "dev",
				status: "booked",
				price: {
					unitAmount: 1000,
					currency: "usd",
					interval: "week",
					intervalCount: 1,
				},
			},
			{
				id: "org",
				status: "booked",
			},
		],
	}),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: { children: ReactNode }) => (
		<a {...props}>{children}</a>
	),
}));

vi.mock("motion/react", () => ({
	motion: {
		li: ({
			children,
			...props
		}: ComponentPropsWithoutRef<"li"> & { children: ReactNode }) => (
			<li {...props}>{children}</li>
		),
	},
}));

vi.mock("#/content/sponsors", () => ({
	SPONSORS: {
		dev: {
			name: "Example sponsor",
			tagline: "Example tagline",
			href: "https://example.com",
			logo: "https://example.com/logo.svg",
		},
		org: null,
	},
}));

vi.mock("#/lib/sponsor", () => ({ sponsorSlotsQueryOptions: {} }));

import { SponsorRow } from "#/components/SponsorRow";

describe("SponsorRow", () => {
	it("does not advertise a booked slot as empty while its creative is pending", () => {
		render(
			<ul>
				<SponsorRow slot="org" />
			</ul>,
		);

		expect(screen.getByText("This sponsor slot is booked")).toBeTruthy();
		expect(screen.getByText("Sponsor announcement coming soon")).toBeTruthy();
		expect(screen.queryByText("This sponsor slot is empty")).toBeNull();
	});

	it("shows sponsor creative without an ad prefix or avatar treatment", () => {
		render(
			<ul>
				<SponsorRow slot="dev" />
			</ul>,
		);

		expect(screen.queryByText(/^ad$/i)).toBeNull();
		const rankGutter = screen.getByRole("link").firstElementChild;
		expect(rankGutter?.getAttribute("aria-hidden")).toBe("true");
		expect(rankGutter?.getAttribute("class")).toContain("w-6");
		const logoClasses = screen.getByRole("img").getAttribute("class");
		expect(logoClasses).toContain("object-contain");
		expect(logoClasses).not.toContain("rounded-full");
	});
});
