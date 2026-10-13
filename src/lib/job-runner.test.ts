import { describe, expect, it } from "vitest";
import { describeError } from "#/lib/job-runner";

describe("describeError", () => {
	it("keeps a plain Error to its message", () => {
		expect(describeError(new Error("boom"))).toBe("boom");
	});

	it("spells out the plain objects pg-boss emits instead of [object Object]", () => {
		const out = describeError({
			message: "fetch failed",
			queue: "org-refresh-v1",
			error: new Error("connection terminated"),
		});
		expect(out).toContain("org-refresh-v1");
		expect(out).toContain("connection terminated");
		expect(out).not.toContain("[object Object]");
	});

	it("keeps an error's code and cause", () => {
		const err = Object.assign(
			new Error("outer", { cause: new Error("inner") }),
			{
				code: "ECONNRESET",
			},
		);
		const out = describeError(err);
		expect(out).toContain("ECONNRESET");
		expect(out).toContain("inner");
	});

	it("survives circular objects and primitives", () => {
		const loop: Record<string, unknown> = {};
		loop.self = loop;
		expect(typeof describeError(loop)).toBe("string");
		expect(describeError("plain")).toBe("plain");
		expect(describeError(undefined)).toBe("undefined");
	});
});
