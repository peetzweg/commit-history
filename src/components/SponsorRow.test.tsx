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

vi.mock("#/lib/sponsor", () => ({ sponsorSlotsQueryOptions: {} }));

import { SponsorRow } from "#/components/SponsorRow";

describe("SponsorRow", () => {
	it("does not advertise a booked slot as empty while its creative is pending", () => {
		render(
			<ul>
				<SponsorRow slot="dev" />
			</ul>,
		);

		expect(screen.getByText("This sponsor slot is booked")).toBeTruthy();
		expect(screen.getByText("Sponsor announcement coming soon")).toBeTruthy();
		expect(screen.queryByText("This sponsor slot is empty")).toBeNull();
	});
});
