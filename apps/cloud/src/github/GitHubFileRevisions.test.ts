import { PullRequestOperationError, type PullRequestDiffRevision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import type { GitHubApi } from "./GitHubApi.ts";
import { makePullRequestFileRevisions } from "./GitHubFileRevisions.ts";
import type { PullRequestDiffFile } from "./PullRequestDiffFiles.ts";

const revision: PullRequestDiffRevision = {
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};
const target = { repository: "acme/web", token: "token" };

const apiWith = (
  answer: (expression: string) => { readonly __typename: string; readonly oid: string } | null,
) => {
  const queries: Array<{
    readonly query: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }> = [];
  const api = {
    graphql: (
      _operation: string,
      token: string,
      query: string,
      variables: Readonly<Record<string, unknown>>,
    ) =>
      Effect.sync(() => {
        expect(token).toBe("token");
        queries.push({ query, variables });
        const repository: Record<string, unknown> = {};
        for (const match of query.matchAll(
          /([A-Za-z0-9_]+): object\(expression: \$([A-Za-z0-9_]+)\)/gu,
        )) {
          const alias = match[1];
          const variable = match[2];
          if (variable === undefined) continue;
          const expression = variables[variable];
          if (alias === undefined || typeof expression !== "string") continue;
          repository[alias] = answer(expression);
        }
        return JSON.stringify({ data: { repository } });
      }),
  } as unknown as GitHubApi;
  return { api, queries };
};

it.effect("pins a file to both immutable blob OIDs, including binary content and renames", () => {
  const f = apiWith((expression) => ({ __typename: "Blob", oid: `blob:${expression}` }));
  const read = makePullRequestFileRevisions(f.api);
  const files: ReadonlyArray<PullRequestDiffFile> = [
    { path: "assets/plot.bin", oldPath: "assets/plot.bin", newPath: "assets/plot.bin" },
    { path: "src/renamed.ts", oldPath: "src/old.ts", newPath: "src/renamed.ts" },
    { path: "src/new.ts", oldPath: null, newPath: "src/new.ts" },
    { path: "src/deleted.ts", oldPath: "src/deleted.ts", newPath: null },
  ];
  return Effect.gen(function* () {
    const revisions = yield* read(target, revision, files);
    expect(revisions.get("assets/plot.bin")).toBe(
      [
        "assets/plot.bin",
        "assets/plot.bin",
        `blob:${revision.baseSha}:assets/plot.bin`,
        "assets/plot.bin",
        `blob:${revision.headSha}:assets/plot.bin`,
      ].join("\u0000"),
    );
    expect(revisions.get("src/renamed.ts")).toContain("src/old.ts");
    expect(revisions.get("src/renamed.ts")).toContain("src/renamed.ts");
    expect(revisions.get("src/new.ts")).toContain("\u0000\u0000src/new.ts");
    expect(revisions.get("src/deleted.ts")).toContain("src/deleted.ts");
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]?.variables).toMatchObject({ owner: "acme", name: "web" });
  });
});

it.effect("fails closed when GitHub cannot resolve a path to a blob", () => {
  return Effect.forEach(
    [apiWith(() => null), apiWith(() => ({ __typename: "Tree", oid: "tree-oid" }))],
    (f) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          makePullRequestFileRevisions(f.api)(target, revision, [
            { path: "src/missing.ts", oldPath: null, newPath: "src/missing.ts" },
          ]),
        );
        expect(error).toBeInstanceOf(PullRequestOperationError);
        expect(error._tag === "PullRequestOperationError" && error.detail).toContain(
          "blob revision",
        );
      }),
  );
});

it.effect("batches 500 changed paths by 50 and rejects a larger request", () => {
  const f = apiWith((expression) => ({ __typename: "Blob", oid: expression }));
  const files = Array.from({ length: 500 }, (_, index) => ({
    path: `src/${index}.bin`,
    oldPath: `src/${index}.bin`,
    newPath: `src/${index}.bin`,
  }));
  return Effect.gen(function* () {
    const revisions = yield* makePullRequestFileRevisions(f.api)(target, revision, files);
    expect(revisions.size).toBe(500);
    expect(f.queries).toHaveLength(10);
    expect(f.queries.map(({ query }) => [...query.matchAll(/: object\(/gu)].length)).toEqual(
      Array.from({ length: 10 }, () => 100),
    );

    const error = yield* Effect.flip(
      makePullRequestFileRevisions(f.api)(target, revision, [...files, files[0]!]),
    );
    expect(error).toBeInstanceOf(PullRequestOperationError);
    expect(error._tag === "PullRequestOperationError" && error.detail).toContain(
      "Too many changed files",
    );
    expect(f.queries).toHaveLength(10);
  });
});
