import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { resolveClaudeSdkReleaseIdentity } from "./buildClaudeSdk.ts";
import { preserveRejectedClaudeSdkCandidate } from "./claudeSdkCandidate.ts";

const temporary: string[] = [];
const sdkPackage = "@anthropic-ai/claude-agent-sdk";
const tarballURL =
  "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.312.tgz";

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

function integrity() {
  return `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
}

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return body;
    },
  };
}

describe("Claude Agent SDK release producer", () => {
  it("resolves the npm current stable tag to an exact release identity", async () => {
    const requests: string[] = [];
    const current = {
      name: sdkPackage,
      version: "0.3.312",
      dist: { integrity: integrity(), tarball: tarballURL },
    };
    const http = async (url: string) => {
      requests.push(url);
      if (url === `https://registry.npmjs.org/${sdkPackage}`) {
        return response({
          name: sdkPackage,
          versions: {
            "0.3.312": current,
            "0.3.313-beta.1": { ...current, version: "0.3.313-beta.1" },
          },
          "dist-tags": { latest: "0.3.312" },
        });
      }
      if (url.endsWith("/0.3.312")) return response(current);
      throw new Error("Unexpected registry request");
    };

    const identity = await resolveClaudeSdkReleaseIdentity(undefined, http);

    expect(identity).toMatchObject({
      provider: "claude-agent-sdk",
      version: "0.3.312",
      upstreamIdentity: `npm:${sdkPackage}`,
      npm: { packageName: sdkPackage, integrity: integrity(), tarball: tarballURL },
    });
    expect(identity.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(requests).toHaveLength(2);
  });

  it("does not select a latest tag that points at a prerelease", async () => {
    const http = async () =>
      response({
        name: sdkPackage,
        versions: { "0.3.313-beta.1": { name: sdkPackage, version: "0.3.313-beta.1" } },
        "dist-tags": { latest: "0.3.313-beta.1" },
      });

    await expect(resolveClaudeSdkReleaseIdentity(undefined, http)).rejects.toThrow(
      "CLAUDE_SDK_CURRENT_STABLE_RELEASE_MISSING",
    );
  });

  it("preserves rejected candidates with path-free failure files", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-sdk-reject-"));
    temporary.push(directory);
    const candidate = NodePath.join(directory, "candidate");
    const output = NodePath.join(directory, "output");
    await NodeFSP.mkdir(candidate);
    await NodeFSP.writeFile(NodePath.join(candidate, "sdk.mjs"), "candidate bytes");

    const rejected = await preserveRejectedClaudeSdkCandidate(
      candidate,
      output,
      "0.3.312",
      new Error(`failed at ${directory}/private-input`),
    );

    const reportBytes = await NodeFSP.readFile(NodePath.join(rejected, "failure.json"));
    expect(reportBytes.toString()).not.toContain(directory);
    expect(JSON.parse(reportBytes.toString())).toMatchObject({
      status: "rejected",
      provider: "claude-agent-sdk",
      version: "0.3.312",
      failureCode: "CLAUDE_SDK_BUILD_FAILED",
    });
    expect(await NodeFSP.readFile(NodePath.join(rejected, "sdk.mjs"), "utf8")).toBe(
      "candidate bytes",
    );
  });

  it("retains the failed source workspace and raw stderr privately", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "claude-sdk-diagnostics-"),
    );
    temporary.push(directory);
    const candidate = NodePath.join(directory, "candidate");
    const output = NodePath.join(directory, "output");
    const workspace = NodePath.join(directory, "workspace");
    await NodeFSP.mkdir(candidate);
    await NodeFSP.mkdir(NodePath.join(workspace, "archives"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(workspace, "cache"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(candidate, "partial.mjs"), "partial component");
    await NodeFSP.writeFile(NodePath.join(workspace, "package-lock.json"), "locked graph");
    await NodeFSP.writeFile(NodePath.join(workspace, "archives", "0000.tgz"), "verified archive");
    await NodeFSP.writeFile(NodePath.join(workspace, "cache", "discarded"), "cache data");
    const error = Object.assign(new Error("CLAUDE_SDK_BUNDLE_BUILD_FAILED"), {
      stderr: `PRIVATE_ESBUILD_MARKER ${directory}/source/sdk.mjs`,
      stdout: "private build output",
    });

    const rejected = await preserveRejectedClaudeSdkCandidate(candidate, output, "0.3.312", error, {
      workspace,
      stage: "bundle",
      releaseIdentity: { version: "0.3.312", integrity: integrity() },
      dependencyGraph: { lockfileSha256: "a".repeat(64) },
      sourceFreeze: { sourceSha256: "b".repeat(64) },
    });

    const report = await NodeFSP.readFile(NodePath.join(rejected, "failure.json"), "utf8");
    expect(report).not.toContain(directory);
    expect(report).not.toContain("PRIVATE_ESBUILD_MARKER");
    expect(JSON.parse(report)).toMatchObject({
      status: "rejected",
      version: "0.3.312",
      failureCode: "CLAUDE_SDK_BUNDLE_BUILD_FAILED",
    });
    const diagnostics = NodePath.join(rejected, "diagnostics");
    expect(await NodeFSP.readFile(NodePath.join(diagnostics, "stderr.log"), "utf8")).toContain(
      `PRIVATE_ESBUILD_MARKER ${directory}/source/sdk.mjs`,
    );
    expect(await NodeFSP.readFile(NodePath.join(diagnostics, "stdout.log"), "utf8")).toBe(
      "private build output",
    );
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(diagnostics, "build-context.json"), "utf8")),
    ).toMatchObject({
      stage: "bundle",
      releaseIdentity: { version: "0.3.312" },
      dependencyGraph: { lockfileSha256: "a".repeat(64) },
      retainedWorkspace: "build-workspace",
    });
    const retainedWorkspace = NodePath.join(rejected, "build-workspace");
    expect(
      await NodeFSP.readFile(NodePath.join(retainedWorkspace, "package-lock.json"), "utf8"),
    ).toBe("locked graph");
    expect(
      await NodeFSP.readFile(NodePath.join(retainedWorkspace, "archives", "0000.tgz"), "utf8"),
    ).toBe("verified archive");
    await expect(NodeFSP.lstat(NodePath.join(retainedWorkspace, "cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
