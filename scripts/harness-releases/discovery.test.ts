import { describe, expect, it } from "vite-plus/test";
import {
  discoverHarnessReleases,
  isStrictStableVersion,
  parseCodexReleasePage,
  parseNpmPackageMetadata,
  selectCodexReleases,
  selectNpmReleases,
  type NpmPackageName,
  type ReleaseDiscoveryResponse,
} from "./discovery.ts";

function npmPackument(
  packageName: NpmPackageName,
  versions: ReadonlyArray<{ readonly version: string; readonly fields?: Record<string, unknown> }>,
  latest = versions[0]?.version ?? "",
) {
  return {
    name: packageName,
    "dist-tags": { latest },
    versions: Object.fromEntries(
      versions.map(({ version, fields = {} }) => [
        version,
        { name: packageName, version, ...fields },
      ]),
    ),
    time: Object.fromEntries(
      versions.map(({ version }, index) => [
        version,
        `2026-10-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      ]),
    ),
  };
}

function codexRelease(version: string, fields: Record<string, unknown> = {}) {
  return {
    tag_name: `rust-v${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-10-19T10:00:00Z",
    target_commitish: "main",
    ...fields,
  };
}

function httpResponse(body: unknown, link: string | null = null): ReleaseDiscoveryResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "link" ? link : null) },
    json: async () => body,
  };
}

describe("harness release discovery", () => {
  it("uses npm latest as current and sorts strict stable versions numerically", () => {
    const packageName = "@anthropic-ai/claude-code";
    const metadata = parseNpmPackageMetadata(
      packageName,
      npmPackument(
        packageName,
        [
          { version: "1.9.0" },
          { version: "1.10.0" },
          { version: "2.0.0", fields: { dist: { integrity: "sha512-registry-value" } } },
          { version: "2.1.0-rc.1" },
          { version: "2.1.0+build.4" },
          { version: "02.1.0" },
          { version: "v2.1.0" },
          { version: "2.1" },
          { version: "2.1.1-01" },
        ],
        "1.9.0",
      ),
    );
    const selected = selectNpmReleases(metadata);

    expect(selected.map((release) => [release.version, release.selection])).toEqual([
      ["1.9.0", "current"],
      ["2.0.0", "backfill"],
      ["1.10.0", "backfill"],
    ]);
    expect(selected[0]).toMatchObject({
      id: "claude-code:1.9.0:npm:@anthropic-ai/claude-code",
      upstreamIdentity: "npm:@anthropic-ai/claude-code",
      publishedAt: "2026-10-01T10:00:00.000Z",
      provenance: { kind: "npm", packageName },
    });
    expect(selected[1]?.provenance).toMatchObject({ integrity: "sha512-registry-value" });
    expect(selected[0]?.provenance).not.toHaveProperty("integrity");
  });

  it("accepts only canonical stable SemVer and safely ignores malformed metadata", () => {
    expect(isStrictStableVersion("1.2.3")).toBe(true);
    for (const version of [
      "1.2",
      "v1.2.3",
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-rc.1",
      "1.2.3-01",
      "1.2.3+build.4",
    ]) {
      expect(isStrictStableVersion(version)).toBe(false);
    }

    const packageName = "@anthropic-ai/claude-agent-sdk";
    expect(parseNpmPackageMetadata(packageName, null)).toEqual({
      packageName,
      current: null,
      stableReleases: [],
    });
    expect(
      parseNpmPackageMetadata(packageName, {
        name: "@anthropic-ai/wrong-package",
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { version: "1.0.0" } },
      }).stableReleases,
    ).toEqual([]);
    expect(
      parseNpmPackageMetadata(
        packageName,
        npmPackument(packageName, [
          { version: "1.0.0", fields: { version: "1.0.1" } },
          { version: "1.0.1", fields: { name: "@anthropic-ai/other" } },
        ]),
      ).stableReleases,
    ).toEqual([]);
    expect(parseCodexReleasePage({ releases: [] })).toEqual([]);
  });

  it("keeps the current Claude release plus the latest fifty stable backfill versions", () => {
    const packageName = "@anthropic-ai/claude-code";
    const versions = Array.from({ length: 55 }, (_, index) => ({ version: `1.0.${index + 1}` }));
    const selected = selectNpmReleases(
      parseNpmPackageMetadata(packageName, npmPackument(packageName, versions, "1.0.55")),
    );

    expect(selected).toHaveLength(51);
    expect(selected[0]).toMatchObject({ version: "1.0.55", selection: "current" });
    expect(selected[1]?.version).toBe("1.0.54");
    expect(selected.at(-1)?.version).toBe("1.0.5");
    expect(selected.some((release) => release.version === "1.0.4")).toBe(false);
  });

  it("watches only the current Claude Agent SDK release", () => {
    const packageName = "@anthropic-ai/claude-agent-sdk";
    const selected = selectNpmReleases(
      parseNpmPackageMetadata(
        packageName,
        npmPackument(packageName, [{ version: "0.9.0" }, { version: "0.10.0" }], "0.10.0"),
      ),
    );

    expect(selected.map((release) => [release.version, release.selection])).toEqual([
      ["0.10.0", "current"],
    ]);
  });

  it("filters Codex releases to published rust-v stable SemVer tags and keeps provenance", () => {
    const parsed = parseCodexReleasePage([
      codexRelease("0.156.1", {
        commit: { sha: "a".repeat(40) },
        target_commitish: "main",
      }),
      codexRelease("0.156.2-rc.1"),
      codexRelease("0.156.3", { prerelease: true }),
      codexRelease("0.156.4", { draft: true }),
      codexRelease("01.156.5"),
      codexRelease("0.156.6", { tag_name: "v0.156.6" }),
      codexRelease("0.156.7", { tag_name: "rust-v0.156.7", draft: undefined }),
      null,
    ]);
    const selected = selectCodexReleases(parsed);

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      id: "codex:0.156.1:github:openai/codex:rust-v0.156.1",
      provider: "codex",
      selection: "current",
      publishedAt: "2026-10-19T10:00:00Z",
      provenance: {
        kind: "github",
        repository: "openai/codex",
        tagName: "rust-v0.156.1",
        targetCommitish: "main",
        commitSha: "a".repeat(40),
      },
    });
  });

  it("keeps the current Codex release plus the latest ten stable versions", () => {
    const releases = parseCodexReleasePage(
      Array.from({ length: 13 }, (_, index) => codexRelease(`0.${index + 1}.0`)),
    );
    const selected = selectCodexReleases(releases);

    expect(selected).toHaveLength(11);
    expect(selected.map((release) => release.version)).toEqual([
      "0.13.0",
      "0.12.0",
      "0.11.0",
      "0.10.0",
      "0.9.0",
      "0.8.0",
      "0.7.0",
      "0.6.0",
      "0.5.0",
      "0.4.0",
      "0.3.0",
    ]);
    expect(selected[0]?.selection).toBe("current");
    expect(selected.slice(1).every((release) => release.selection === "backfill")).toBe(true);
  });

  it("deduplicates overlapping Codex pages and emits all current releases before backfill", async () => {
    const pageOne = Array.from({ length: 8 }, (_, index) => codexRelease(`1.0.${index}`));
    const pageTwo = [
      codexRelease("1.0.7", { published_at: "2026-10-20T10:00:00Z" }),
      codexRelease("1.0.8"),
      codexRelease("1.0.9"),
      codexRelease("1.0.10"),
    ];
    const pageTwoUrl = "https://api.github.com/repos/openai/codex/releases?per_page=100&page=2";
    const calls: string[] = [];
    const http = async (url: string) => {
      calls.push(url);
      if (url === "https://registry.npmjs.org/@anthropic-ai/claude-code") {
        return httpResponse(npmPackument("@anthropic-ai/claude-code", [{ version: "2.0.0" }]));
      }
      if (url === "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk") {
        return httpResponse(npmPackument("@anthropic-ai/claude-agent-sdk", [{ version: "0.9.0" }]));
      }
      if (url.endsWith("page=1")) {
        return httpResponse(
          pageOne,
          `<${pageTwoUrl}>; rel="next", <https://api.github.com/repos/openai/codex/releases?per_page=100&page=2>; rel="last"`,
        );
      }
      if (url === pageTwoUrl) return httpResponse(pageTwo);
      throw new Error(`Unexpected URL: ${url}`);
    };

    const releases = await discoverHarnessReleases(http);
    const codex = releases.filter((release) => release.provider === "codex");

    expect(calls.filter((url) => url.includes("/releases?")).sort()).toEqual(
      ["https://api.github.com/repos/openai/codex/releases?per_page=100&page=1", pageTwoUrl].sort(),
    );
    expect(codex.map((release) => release.version)).toEqual([
      "1.0.10",
      "1.0.9",
      "1.0.8",
      "1.0.7",
      "1.0.6",
      "1.0.5",
      "1.0.4",
      "1.0.3",
      "1.0.2",
      "1.0.1",
      "1.0.0",
    ]);
    expect(codex.find((release) => release.version === "1.0.7")?.publishedAt).toBe(
      "2026-10-19T10:00:00Z",
    );
    expect(releases.slice(0, 3).map((release) => release.selection)).toEqual([
      "current",
      "current",
      "current",
    ]);
    expect(new Set(codex.map((release) => release.id)).size).toBe(codex.length);
  });

  it("rejects a Codex pagination link outside the official releases endpoint", async () => {
    const http = async (url: string) => {
      if (url.endsWith("claude-code")) {
        return httpResponse(npmPackument("@anthropic-ai/claude-code", [{ version: "2.0.0" }]));
      }
      if (url.endsWith("claude-agent-sdk")) {
        return httpResponse(npmPackument("@anthropic-ai/claude-agent-sdk", [{ version: "0.9.0" }]));
      }
      return httpResponse([], '<https://example.com/steal>; rel="next"');
    };

    await expect(discoverHarnessReleases(http)).rejects.toThrow(
      "Codex release discovery returned an unexpected pagination URL",
    );
  });

  it("fails live discovery when npm metadata is malformed or has no stable current version", async () => {
    const http = async (url: string) => {
      if (url.endsWith("claude-code")) {
        return httpResponse(npmPackument("@anthropic-ai/claude-code", [{ version: "2.0.0" }]));
      }
      if (url.endsWith("claude-agent-sdk")) {
        return httpResponse({
          name: "@anthropic-ai/claude-agent-sdk",
          versions: { "0.9.0": { name: "@anthropic-ai/claude-agent-sdk", version: "0.9.0" } },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await expect(discoverHarnessReleases(http)).rejects.toThrow(
      "No stable current release in npm metadata for @anthropic-ai/claude-agent-sdk",
    );
  });

  it("fails live discovery when Codex metadata has no stable rust-v release", async () => {
    const http = async (url: string) => {
      if (url.endsWith("claude-code")) {
        return httpResponse(npmPackument("@anthropic-ai/claude-code", [{ version: "2.0.0" }]));
      }
      if (url.endsWith("claude-agent-sdk")) {
        return httpResponse(npmPackument("@anthropic-ai/claude-agent-sdk", [{ version: "0.9.0" }]));
      }
      return httpResponse([codexRelease("0.156.1-rc.1"), codexRelease("0.156.2", { draft: true })]);
    };

    await expect(discoverHarnessReleases(http)).rejects.toThrow(
      "No stable Codex releases found in official release metadata",
    );
  });
});
