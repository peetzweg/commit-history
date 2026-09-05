import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFollowing } from "#/lib/github-following";

function response(
	rows: Array<Record<string, unknown>>,
	link: string | null = null,
) {
	return {
		ok: true,
		status: 200,
		headers: { get: (name: string) => (name === "link" ? link : null) },
		json: async () => rows,
	};
}

function row(index: number) {
	return {
		login: `person-${index}`,
		node_id: `U_${index}`,
		avatar_url: `https://avatars.example/${index}`,
		html_url: `https://github.com/person-${index}`,
		type: "User",
	};
}

describe("fetchFollowing", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("paginates to a complete, immutable-id-keyed snapshot", async () => {
		const calls: URL[] = [];
		vi.stubGlobal("fetch", async (url: URL) => {
			calls.push(url);
			return calls.length === 1
				? response(
						Array.from({ length: 100 }, (_, index) => row(index)),
						'<https://api.github.com/users/owner/following?page=2>; rel="next"',
					)
				: response([row(100)]);
		});

		const result = await fetchFollowing("owner", "token");

		expect(result).toHaveLength(101);
		expect(result.at(-1)).toEqual({
			githubNodeId: "U_100",
			login: "person-100",
			avatarUrl: "https://avatars.example/100",
			htmlUrl: "https://github.com/person-100",
			kind: "user",
		});
		expect(calls.map((url) => url.searchParams.get("page"))).toEqual([
			"1",
			"2",
		]);
	});

	it("rejects a malformed member instead of returning a partial snapshot", async () => {
		vi.stubGlobal("fetch", async () => response([{ login: "person" }]));

		await expect(fetchFollowing("owner", "token")).rejects.toThrow(
			"invalid followed profile",
		);
	});

	it("deduplicates identities repeated across shifting pages", async () => {
		vi.stubGlobal("fetch", async () => response([row(1), row(1)]));

		await expect(fetchFollowing("owner", "token")).resolves.toHaveLength(1);
	});

	it("classifies users and organizations while excluding unsupported account kinds", async () => {
		vi.stubGlobal("fetch", async () =>
			response([
				row(1),
				{ ...row(2), type: "Organization" },
				{ ...row(3), type: "Bot" },
				{ ...row(4), type: "Mannequin" },
			]),
		);

		await expect(fetchFollowing("owner", "token")).resolves.toEqual([
			{
				githubNodeId: "U_1",
				login: "person-1",
				avatarUrl: "https://avatars.example/1",
				htmlUrl: "https://github.com/person-1",
				kind: "user",
			},
			{
				githubNodeId: "U_2",
				login: "person-2",
				avatarUrl: "https://avatars.example/2",
				htmlUrl: "https://github.com/person-2",
				kind: "org",
			},
		]);
	});
});
