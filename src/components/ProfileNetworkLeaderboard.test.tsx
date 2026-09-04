// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	networkData: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: mocks.networkData }),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => (
		<a href="/profile">{children}</a>
	),
}));

vi.mock("motion/react", () => ({
	AnimatePresence: ({ children }: { children: ReactNode }) => children,
	motion: {
		li: ({
			children,
			className,
		}: ComponentPropsWithoutRef<"li"> & { children: ReactNode }) => (
			<li className={className}>{children}</li>
		),
	},
}));

vi.mock("#/components/ExplainerLink", () => ({
	ExplainerLink: () => <a href="/-/metrics/commits">What is this?</a>,
}));

import { ProfileNetworkLeaderboard } from "#/components/ProfileNetworkLeaderboard";

const entry = (login: string, isOwner = false) => ({
	githubNodeId: `U_${login}`,
	login,
	name: null,
	avatarUrl: `https://avatars.example/${login}`,
	totalCommits: isOwner ? 20 : 30,
	totalRestricted: 0,
	totalIssues: 0,
	totalPullRequests: 0,
	totalReviews: 0,
	totalRepos: 0,
	followers: 0,
	isOwner,
});

describe("ProfileNetworkLeaderboard", () => {
	afterEach(cleanup);

	beforeEach(() => {
		mocks.networkData = {
			status: "ready",
			ownerLogin: "owner",
			totalCount: 2,
			readyCount: 1,
			unavailableCount: 0,
			rows: [entry("friend"), entry("owner", true)],
			hasError: false,
		};
	});

	it("renders the available ranking and clearly marks it provisional", () => {
		render(
			<ProfileNetworkLeaderboard
				login="owner"
				ownerGithubNodeId="U_owner"
				metric="public"
			/>,
		);

		expect(screen.getByText(/1 of 2 followed profiles ready/)).toBeTruthy();
		expect(screen.getByText("this profile")).toBeTruthy();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	it("stops showing progress when the complete cohort is available", () => {
		mocks.networkData.readyCount = 2;
		mocks.networkData.rows = [
			entry("friend"),
			entry("other"),
			entry("owner", true),
		];
		render(
			<ProfileNetworkLeaderboard
				login="owner"
				ownerGithubNodeId="U_owner"
				metric="public"
			/>,
		);

		expect(screen.queryByText(/being added in the background/)).toBeNull();
	});

	it("settles when a followed profile is no longer available", () => {
		mocks.networkData.unavailableCount = 1;
		render(
			<ProfileNetworkLeaderboard
				login="owner"
				ownerGithubNodeId="U_owner"
				metric="public"
			/>,
		);

		expect(screen.getByText(/1 could not be loaded/)).toBeTruthy();
		expect(screen.queryByText(/being added in the background/)).toBeNull();
	});
});
