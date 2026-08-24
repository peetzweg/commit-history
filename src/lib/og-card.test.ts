import { describe, expect, it } from "vitest";
import {
	displayNameLines,
	githubCard,
	orgCard,
	trendDataUrl,
} from "#/lib/og-card";

function svg(values: readonly number[]) {
	const dataUrl = trendDataUrl(values);
	return Buffer.from(dataUrl.split(",")[1], "base64").toString("utf8");
}

describe("trendDataUrl", () => {
	it("renders a cumulative line from the supplied contribution windows", () => {
		const image = svg([0, 10, 0, 20]);
		expect(image).toContain('stroke="#16a34a"');
		expect(image).toContain('stroke-width="4"');
		expect(image).not.toContain('opacity="0.22"');
		expect(image).toContain("M8.0,312.0");
		expect(image).toContain("L552.0,8.0");
	});

	it("keeps the zero-history case intentionally flat instead of using a decorative curve", () => {
		const image = svg([]);
		expect(image).toContain("M8.0,312.0 L552.0,312.0");
		expect(image).not.toContain(" C ");
	});
});

describe("orgCard", () => {
	it("reserves the 25th grid cell for the remaining members", () => {
		const card = orgCard({
			login: "acme",
			name: "Acme",
			avatarDataUrl: null,
			place: null,
			commits: 1,
			memberAvatarDataUrls: Array.from({ length: 25 }, () => null),
			memberCount: 43,
		});
		const rendered = JSON.stringify(card);
		expect(rendered).toContain("+19");
		expect(rendered).not.toContain('"25"');
	});
});

describe("githubCard", () => {
	it("labels the aggregate scope, metric total, and uses its supplied live trend", () => {
		const card = githubCard({
			metricLabel: "public commits",
			total: 123_456,
			trackedUsers: 789,
			trendValues: [2, 3, 5],
		});
		const rendered = JSON.stringify(card);
		const visual = card.props.children as unknown as {
			props: { src: string };
		}[];
		const graphSvg = Buffer.from(
			visual[0].props.src.split(",")[1],
			"base64",
		).toString("utf8");
		expect(rendered).toContain("GitHub activity");
		expect(rendered).toContain("789 tracked users");
		expect(rendered).toContain("123,456");
		expect(rendered).toContain("public commits");
		expect(graphSvg).toContain("M8.0,251.2");
	});
});

describe("displayNameLines", () => {
	it("balances a long name across two title lines", () => {
		expect(displayNameLines("Apache Software Foundation")).toEqual([
			"Apache Software",
			"Foundation",
		]);
	});

	it("leaves short and single-word names on one line", () => {
		expect(displayNameLines("Apache")).toEqual(["Apache"]);
		expect(displayNameLines("AReallyLongSingleWordName")).toEqual([
			"AReallyLongSingleWordName",
		]);
	});
});
