import { describe, expect, it } from "vite-plus/test";
import {
  codexBuildPin,
  parseOfficialReleaseIdentity,
  resolveOfficialRelease,
  type IdentityHttp,
} from "./releaseIdentity.ts";

const tag = "rust-v0.163.0";
const commit = "a".repeat(40);
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const http =
  (values: Record<string, unknown>): IdentityHttp =>
  async (url) => {
    const body = values[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: async () => body,
    };
  };
const github = "https://api.github.com/repos/openai/codex";
const codexResponses = () => ({
  [`${github}/releases/tags/${tag}`]: { tag_name: tag, draft: false, prerelease: false },
  [`${github}/git/ref/tags/${tag}`]: {
    ref: `refs/tags/${tag}`,
    object: { type: "tag", sha: "b".repeat(40) },
  },
  [`${github}/git/tags/${"b".repeat(40)}`]: { object: { type: "commit", sha: commit } },
});

describe("official release identity", () => {
  it("peels an annotated tag and preserves every wrapper pin except release data", async () => {
    const identity = await resolveOfficialRelease("codex", "0.163.0", http(codexResponses()));
    expect(parseOfficialReleaseIdentity(identity)).toEqual(identity);
    expect(() =>
      parseOfficialReleaseIdentity({
        ...identity,
        codex: { ...identity.codex!, commit: "d".repeat(40) },
      }),
    ).toThrow("RELEASE_IDENTITY_HASH_MISMATCH");
    expect(identity.codex?.commit).toBe(commit);
    const base = {
      version: "0.162.1",
      tag: "rust-v0.162.1",
      commit: "c".repeat(40),
      repository: "https://github.com/openai/codex.git",
      rust: "nightly-pinned",
      targets: ["wasm32-wasip1", "wasm32-unknown-emscripten"],
      references: { input: { commit: "fixed" } },
      extra: "retained",
    };
    const pin = codexBuildPin(base, identity);
    expect(pin).toEqual({ ...base, version: "0.163.0", tag, commit });
    expect(base.version).toBe("0.162.1");
  });

  it("rejects moving branches, tag loops, drafts and non-exact versions", async () => {
    const responses = codexResponses();
    await expect(resolveOfficialRelease("codex", "latest", http(responses))).rejects.toThrow(
      "EXACT_STABLE",
    );
    await expect(
      resolveOfficialRelease("codex", "0.163.0-alpha.1", http(responses)),
    ).rejects.toThrow("EXACT_STABLE");
    const draft = {
      ...responses,
      [`${github}/releases/tags/${tag}`]: { tag_name: tag, draft: true, prerelease: false },
    };
    await expect(resolveOfficialRelease("codex", "0.163.0", http(draft))).rejects.toThrow(
      "STABLE_TAG",
    );
    const loop = {
      ...responses,
      [`${github}/git/tags/${"b".repeat(40)}`]: { object: { type: "tag", sha: "b".repeat(40) } },
    };
    await expect(resolveOfficialRelease("codex", "0.163.0", http(loop))).rejects.toThrow(
      "PEEL_FAILED",
    );
    const branch = {
      ...responses,
      [`${github}/git/ref/tags/${tag}`]: {
        ref: "refs/heads/main",
        object: { type: "commit", sha: commit },
      },
    };
    await expect(resolveOfficialRelease("codex", "0.163.0", http(branch))).rejects.toThrow(
      "TAG_MISMATCH",
    );
  });

  it("freezes an exact SDK npm integrity and rejects foreign metadata or tarballs", async () => {
    const url = "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk/1.2.3";
    const metadata = {
      name: "@anthropic-ai/claude-agent-sdk",
      version: "1.2.3",
      dist: {
        integrity,
        tarball:
          "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-1.2.3.tgz",
      },
    };
    const identity = await resolveOfficialRelease(
      "claude-agent-sdk",
      "1.2.3",
      http({ [url]: metadata }),
    );
    expect(identity.npm?.integrity).toBe(integrity);
    expect(identity.binary).toBeUndefined();
    await expect(
      resolveOfficialRelease(
        "claude-agent-sdk",
        "1.2.3",
        http({ [url]: { ...metadata, version: "1.2.4" } }),
      ),
    ).rejects.toThrow("NPM_MISMATCH");
    await expect(
      resolveOfficialRelease(
        "claude-agent-sdk",
        "1.2.3",
        http({
          [url]: { ...metadata, dist: { integrity, tarball: "https://other.invalid/package.tgz" } },
        }),
      ),
    ).rejects.toThrow("ORIGIN_MISMATCH");
  });

  it("requires positive official Claude bytes and binds the complete manifest", async () => {
    const npm = "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/2.1.303";
    const manifest =
      "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.303/manifest.json";
    const metadata = {
      name: "@anthropic-ai/claude-code",
      version: "2.1.303",
      dist: { integrity, tarball: "https://registry.npmjs.org/claude.tgz" },
    };
    const artifact = { binary: "claude", size: 123, checksum: "d".repeat(64) };
    const body = { version: "2.1.303", platforms: { "linux-x64": artifact } };
    const identity = await resolveOfficialRelease(
      "claude-code",
      "2.1.303",
      http({ [npm]: metadata, [manifest]: body }),
    );
    expect(identity.binary?.bytes).toBe(123);
    expect(identity.binary?.manifestSha256).toHaveLength(64);
    for (const size of [0, -1, 1.2])
      await expect(
        resolveOfficialRelease(
          "claude-code",
          "2.1.303",
          http({
            [npm]: metadata,
            [manifest]: { ...body, platforms: { "linux-x64": { ...artifact, size } } },
          }),
        ),
      ).rejects.toThrow("BINARY_INVALID");
  });
});
