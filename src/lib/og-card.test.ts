import { describe, expect, it } from "vitest";
import { displayNameLines, orgCard, trendDataUrl } from "#/lib/og-card";

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
