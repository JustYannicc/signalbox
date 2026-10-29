// @effect-diagnostics nodeBuiltinImport:off - verifies pre-write filesystem checks with isolated df executables.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { extract } from "./extract.ts";
import { fixture } from "./graph-fixture.ts";
import { extractRelease } from "./releases.ts";

async function controlledDf(directory: string, failingFlag: string) {
  const bin = NodePath.join(directory, "bin");
  await NodeFSP.mkdir(bin);
  const df = NodePath.join(bin, "df");
  await NodeFSP.writeFile(
    df,
    `#!/bin/sh\nif [ "$1" = "${failingFlag}" ]; then exit 1; fi\nprintf 'Filesystem Size Used Avail Use%% Mounted on\\n/test 100 10 90 10%% /\\n'\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", bin);
}

it.each(["-hP", "-iP"])("refuses extraction before staging if df %s fails", async (flag) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-preflight-"));
  try {
    await controlledDf(directory, flag);
    const binary = NodePath.join(directory, "binary");
    await NodeFSP.writeFile(binary, fixture().bytes);
    const events: Record<string, unknown>[] = [];
    await expect(
      extract(binary, NodePath.join(directory, "out"), {
        diagnostics: (event) => events.push(event),
      }),
    ).rejects.toThrow("filesystem measurements unavailable");
    expect((await NodeFSP.readdir(directory)).sort()).toEqual(["bin", "binary"]);
    expect(events[0]?.event).toBe("bun-extraction-plan");
    const measured = events.find((event) => event.event === "bun-extraction-filesystem");
    expect(measured?.df).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: `df ${flag}`, status: 1 })]),
    );
  } finally {
    vi.unstubAllEnvs();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it.each(["-hP", "-iP"])(
  "refuses a release directory and binary download if df %s fails",
  async (flag) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-preflight-"));
    try {
      await controlledDf(directory, flag);
      const bytes = fixture().bytes;
      const fetch = vi.fn(async () =>
        Response.json({
          version: "1.2.3",
          platforms: {
            "linux-x64": {
              binary: "claude",
              size: bytes.length,
              checksum: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            },
          },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        extractRelease("1.2.3", NodePath.join(directory, "release"), "linux-x64", {
          diagnostics: () => {},
        }),
      ).rejects.toThrow("filesystem measurements unavailable");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await NodeFSP.readdir(directory)).toEqual(["bin"]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

it("measures the release filesystem before mkdir and downloading the binary", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bun-preflight-"));
  const release = NodePath.join(directory, "release");
  const bytes = fixture().bytes;
  let preflightRecorded = false;
  let downloaded = false;
  vi.stubGlobal("fetch", async (resource: string | URL | Request) => {
    if (String(resource).endsWith("manifest.json"))
      return Response.json({
        version: "1.2.3",
        platforms: {
          "linux-x64": {
            binary: "claude",
            size: bytes.length,
            checksum: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          },
        },
      });
    expect(preflightRecorded).toBe(true);
    expect(NodeFS.readdirSync(release)).toEqual([]);
    downloaded = true;
    return new Response(bytes);
  });
  try {
    await extractRelease("1.2.3", release, "linux-x64", {
      diagnostics: (event) => {
        if (event.role !== "release-directory") return;
        expect(NodeFS.existsSync(release)).toBe(false);
        expect(downloaded).toBe(false);
        expect(event.df).toEqual([
          expect.objectContaining({ command: "df -hP", status: 0 }),
          expect.objectContaining({ command: "df -iP", status: 0 }),
        ]);
        preflightRecorded = true;
      },
    });
    expect(downloaded).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
