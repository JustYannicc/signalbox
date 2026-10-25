import { describe, expect, it } from "@effect/vitest";

import { contentDigest, selectAdjacentRecordedUserRoute } from "./replayInputRouting.ts";

describe("adjacent recorded user route matching", () => {
  it("checks ordered records when the descriptor contains only the first input digest", async () => {
    const first = await contentDigest("first input");
    const last = await contentDigest("last input");
    const result = await selectAdjacentRecordedUserRoute(
      [
        { type: "text", text: "first input\n" },
        { type: "text", text: "last input" },
      ],
      [{ routeId: "route-a", firstUserContentSha256: first }],
      () => [first, last],
    );

    expect(result).toMatchObject({ status: "matched", routeId: "route-a" });
  });

  it("matches ordered merged blocks using one CLI-added LF per nonfinal block", async () => {
    const content = [
      { type: "text", text: "first input\n" },
      { type: "text", text: "second input\n" },
      { type: "text", text: "final input" },
    ];
    const first = await contentDigest("first input");
    const second = await contentDigest("second input");
    const final = await contentDigest("final input");
    const result = await selectAdjacentRecordedUserRoute(
      content,
      [{ routeId: "route-a", userContentSha256s: [first, second, final] }],
      () => [first, first, second, final],
    );

    expect(result).toEqual({
      status: "matched",
      routeId: "route-a",
      reason: "adjacent-recorded-user-content",
    });
  });

  it("reports distinct routes when both have the same adjacent recorded inputs", async () => {
    const content = [
      { type: "text", text: "first\n" },
      { type: "text", text: "last" },
    ];
    const first = await contentDigest("first");
    const last = await contentDigest("last");
    const routes = ["route-a", "route-b"].map((routeId) => ({
      routeId,
      userContentSha256s: [first, last],
    }));

    await expect(
      selectAdjacentRecordedUserRoute(content, routes, () => [first, last]),
    ).resolves.toEqual({
      status: "ambiguous",
      candidateCount: 2,
      reason: "adjacent-recorded-user-content",
    });
  });

  it("does not join nonadjacent inputs within one route", async () => {
    const content = [
      { type: "text", text: "first\n" },
      { type: "text", text: "last" },
    ];
    const first = await contentDigest("first");
    const middle = await contentDigest("unrelated");
    const last = await contentDigest("last");
    const route = [{ routeId: "route-a", userContentSha256s: [first, middle, last] }];

    await expect(
      selectAdjacentRecordedUserRoute(content, route, () => [first, middle, last]),
    ).resolves.toBeNull();
  });

  it("does not join matching fragments from separate routes", async () => {
    const content = [
      { type: "text", text: "first\n" },
      { type: "text", text: "last" },
    ];
    const first = await contentDigest("first");
    const middle = await contentDigest("unrelated");
    const last = await contentDigest("last");
    const routes = [
      { routeId: "route-a", userContentSha256s: [first, last] },
      { routeId: "route-b", userContentSha256s: [first, last] },
    ];
    const lookup = (routeId: string) => (routeId === "route-a" ? [first, middle] : [middle, last]);

    await expect(selectAdjacentRecordedUserRoute(content, routes, lookup)).resolves.toBeNull();
  });

  it("rejects missing, altered, and doubled separator LFs", async () => {
    const first = await contentDigest("first");
    const altered = await contentDigest("first ");
    const doubled = await contentDigest("first\n");
    const last = await contentDigest("last");
    const routes = [
      {
        routeId: "route-a",
        userContentSha256s: [first, altered, doubled, last],
      },
    ];
    const inputs = [first, last];

    await expect(
      selectAdjacentRecordedUserRoute(
        [
          { type: "text", text: "first" },
          { type: "text", text: "last" },
        ],
        routes,
        () => inputs,
      ),
    ).resolves.toBeNull();
    await expect(
      selectAdjacentRecordedUserRoute(
        [
          { type: "text", text: "first \n" },
          { type: "text", text: "last" },
        ],
        routes,
        () => inputs,
      ),
    ).resolves.toBeNull();
    await expect(
      selectAdjacentRecordedUserRoute(
        [
          { type: "text", text: "first\n\n" },
          { type: "text", text: "last" },
        ],
        routes,
        () => inputs,
      ),
    ).resolves.toBeNull();
  });

  it("rejects reordered inputs and extra text blocks", async () => {
    const first = await contentDigest("first");
    const second = await contentDigest("second");
    const extra = await contentDigest("extra");
    const route = [{ routeId: "route-a", userContentSha256s: [first, second, extra] }];

    await expect(
      selectAdjacentRecordedUserRoute(
        [
          { type: "text", text: "first\n" },
          { type: "text", text: "second" },
        ],
        route,
        () => [second, first],
      ),
    ).resolves.toBeNull();
    await expect(
      selectAdjacentRecordedUserRoute(
        [
          { type: "text", text: "first\n" },
          { type: "text", text: "second\n" },
          { type: "text", text: "extra" },
        ],
        route,
        () => [first, second],
      ),
    ).resolves.toBeNull();
  });

  it("requires text-only blocks with no extra properties and at least two blocks", async () => {
    const lookup = () => [];
    const route = [{ routeId: "route-a", userContentSha256s: [] }];

    await expect(selectAdjacentRecordedUserRoute("text", route, lookup)).resolves.toBeNull();
    await expect(
      selectAdjacentRecordedUserRoute([{ type: "text", text: "only" }], route, lookup),
    ).resolves.toBeNull();
    await expect(
      selectAdjacentRecordedUserRoute(
        [
          { type: "text", text: "first\n", source: "unknown" },
          { type: "text", text: "last" },
        ],
        route,
        lookup,
      ),
    ).resolves.toBeNull();
    await expect(
      selectAdjacentRecordedUserRoute(
        [
          { type: "image", text: "first\n" },
          { type: "text", text: "last" },
        ],
        route,
        lookup,
      ),
    ).resolves.toBeNull();
  });

  it("preserves a newline already present in the original nonfinal input", async () => {
    const content = [
      { type: "text", text: "first\n\n" },
      { type: "text", text: "last" },
    ];
    const first = await contentDigest("first\n");
    const last = await contentDigest("last");
    const result = await selectAdjacentRecordedUserRoute(
      content,
      [{ routeId: "route-a", userContentSha256s: [first, last] }],
      () => [first, last],
    );

    expect(result).toMatchObject({ status: "matched", routeId: "route-a" });
  });
});
