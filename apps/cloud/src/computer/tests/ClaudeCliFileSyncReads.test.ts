import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

type Fs = Parameters<NonNullable<NonNullable<Parameters<typeof fixture>[3]>["seed"]>>[0];

const files = {
  "/home/u/.claude/settings.json": '{"permissions":{"allow":[]}}',
  "/home/u/.claude.json": '{"numStartups":1}',
  "/work/.claude/settings.json": '{"permissions":{"deny":[]}}',
  "/work/.mcp.json": '{"mcpServers":{}}',
  "/work/.git/HEAD": "ref: refs/heads/main\n",
  "/work/.git/config": "[core]\n\tbare = false\n",
  "/work/.git/refs/heads/main": `${"a".repeat(40)}\n`,
};

function workspace(fs: Fs) {
  for (const directory of [
    "/home/u/.claude",
    "/work/.claude",
    "/work/.git/refs/heads",
    "/work/.git/objects/aa",
    "/work/src",
  ])
    fs.mkdirSync(directory, { recursive: true });
  for (const [path, text] of Object.entries(files)) fs.writeFileSync(path, text);
  fs.writeFileSync("/work/.git/refs/heads/other", `${"b".repeat(40)}\n`);
  fs.writeFileSync("/work/.git/objects/aa/object", "x".repeat(4096));
  fs.writeFileSync("/work/src/app.ts", "export {};\n");
}

const open = (seed: (fs: Fs) => void = workspace, metadataLimit = 128) =>
  fixture(64 * 1024, [], false, { cwd: "/work", home: "/home/u", metadataLimit, seed });

describe("CLI filesystem synchronous reads", () => {
  it("keeps the CLI's own settings and git metadata readable without a caller's list", async () => {
    const f = await open();
    try {
      for (const [path, text] of Object.entries(files))
        expect(f.fs.readFileSync(path, "utf8"), path).toBe(text);
      // Nothing else in the workspace, its git objects or other branches is held.
      const bytes = Object.values(files).reduce((total, text) => total + text.length, 0);
      expect(f.prefetchedBytes).toBe(bytes);
    } finally {
      await f.close();
    }
  });

  it("answers a sync read of a directory with EISDIR, as Linux does for /work/.git", async () => {
    const f = await open();
    try {
      expect(() => f.fs.readFileSync("/work/.git", "utf8")).toThrow(
        expect.objectContaining({ code: "EISDIR" }),
      );
    } finally {
      await f.close();
    }
  });

  it("follows a worktree's gitfile to its HEAD, common config and branch", async () => {
    const f = await open((fs) => {
      fs.mkdirSync("/work", { recursive: true });
      fs.mkdirSync("/repo/.git/worktrees/w", { recursive: true });
      fs.mkdirSync("/repo/.git/refs/heads", { recursive: true });
      fs.writeFileSync("/work/.git", "gitdir: /repo/.git/worktrees/w\n");
      fs.writeFileSync("/repo/.git/worktrees/w/HEAD", "ref: refs/heads/feature\n");
      fs.writeFileSync("/repo/.git/worktrees/w/commondir", "../..\n");
      fs.writeFileSync("/repo/.git/config", "[core]\n");
      fs.writeFileSync("/repo/.git/refs/heads/feature", `${"c".repeat(40)}\n`);
    });
    try {
      expect(f.fs.readFileSync("/work/.git", "utf8")).toBe("gitdir: /repo/.git/worktrees/w\n");
      expect(f.fs.readFileSync("/repo/.git/worktrees/w/HEAD", "utf8")).toBe(
        "ref: refs/heads/feature\n",
      );
      expect(f.fs.readFileSync("/repo/.git/config", "utf8")).toBe("[core]\n");
      expect(f.fs.readFileSync("/repo/.git/refs/heads/feature", "utf8")).toBe(
        `${"c".repeat(40)}\n`,
      );
    } finally {
      await f.close();
    }
  });

  it("holds the branch a child's checkout points HEAD at", async () => {
    const f = await open();
    try {
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/work/.git/HEAD", "ref: refs/heads/other\n");
      await f.files.afterRemote();
      expect(f.fs.readFileSync("/work/.git/HEAD", "utf8")).toBe("ref: refs/heads/other\n");
      expect(f.fs.readFileSync("/work/.git/refs/heads/other", "utf8")).toBe(`${"b".repeat(40)}\n`);
    } finally {
      await f.close();
    }
  });

  it("answers a sync read the view can't serve with EIO, traces it without the path, and serves the next one", async () => {
    const f = await open();
    try {
      expect(() => f.fs.readFileSync("/work/src/app.ts", "utf8")).toThrow(
        expect.objectContaining({ code: "EIO" }),
      );
      expect(f.traces).toContainEqual({
        kind: "sync-miss",
        operation: "open",
        reason: "content",
        root: "workspace",
        count: 1,
      });
      expect(JSON.stringify(f.traceRows())).not.toContain("app.ts");
      await f.files.barrier();
      expect(f.fs.readFileSync("/work/src/app.ts", "utf8")).toBe("export {};\n");
    } finally {
      await f.close();
    }
  });

  it("reads a file a child just created, a new name each time, as the Bash tool's cwd file", async () => {
    const f = await open();
    try {
      for (const id of ["a", "b", "c"]) {
        await f.files.beforeRemote();
        f.canonical.mkdirSync("/tmp", { recursive: true });
        f.canonical.writeFileSync(`/tmp/claude-${id}-cwd`, "/work\n");
        await f.files.afterRemote();
        expect(f.fs.readFileSync(`/tmp/claude-${id}-cwd`, "utf8")).toBe("/work\n");
      }
    } finally {
      await f.close();
    }
  });

  it("holds a child's many new files only where the CLI read synchronously before", async () => {
    const f = await open(workspace, 1_024);
    try {
      const burst = async (directory: string, prefix: string) => {
        await f.files.beforeRemote();
        f.canonical.mkdirSync(directory, { recursive: true });
        for (let index = 0; index < 100; index++)
          f.canonical.writeFileSync(`${directory}/${prefix}${index}`, `${prefix}${index}`);
        await f.files.afterRemote();
      };
      await burst("/out", "a");
      expect(() => f.fs.readFileSync("/out/a1")).toThrow(expect.objectContaining({ code: "EIO" }));
      await burst("/out", "b");
      expect(f.fs.readFileSync("/out/b1", "utf8")).toBe("b1");
    } finally {
      await f.close();
    }
  });

  it("always reads the CLI's own config, even larger than the byte budget", async () => {
    const config = `{"projects":"${"p".repeat(100 * 1024)}"}`;
    const f = await fixture(64 * 1024, ["/sync"], false, {
      cwd: "/work",
      home: "/home/u",
      seed(fs) {
        workspace(fs);
        fs.writeFileSync("/home/u/.claude.json", config);
        fs.writeFileSync("/filler", "f".repeat(60 * 1024));
      },
    });
    try {
      expect(f.fs.readFileSync("/home/u/.claude.json", "utf8")).toBe(config);
      // Other files filling the budget never push it out.
      expect(() => f.fs.readFileSync("/filler")).toThrow(expect.objectContaining({ code: "EIO" }));
      await f.files.barrier();
      expect(f.fs.readFileSync("/filler", "utf8")).toHaveLength(60 * 1024);
      expect(f.fs.readFileSync("/home/u/.claude.json", "utf8")).toBe(config);
    } finally {
      await f.close();
    }
  });

  it("starts beside a repository's oversized sync-read files and answers them with EIO", async () => {
    const huge = "h".repeat(5 * 1024 * 1024);
    const f = await fixture(1024 * 1024, [], false, {
      cwd: "/work",
      home: "/home/u",
      seed(fs) {
        workspace(fs);
        fs.writeFileSync("/work/.mcp.json", huge);
        fs.writeFileSync("/work/.git/packed-refs", huge);
      },
    });
    try {
      expect(f.prefetchedBytes).toBeLessThan(1024 * 1024);
      expect(() => f.fs.readFileSync("/work/.mcp.json")).toThrow(
        expect.objectContaining({ code: "EIO" }),
      );
      expect(f.traces).toContainEqual({
        kind: "too-large",
        bytes: huge.length,
        limit: 4 * 1024 * 1024,
      });
      expect(f.fs.readFileSync("/work/.git/HEAD", "utf8")).toBe(files["/work/.git/HEAD"]);
    } finally {
      await f.close();
    }
  });

  it("pins at most 16 MiB of the CLI's own sync-read files", async () => {
    const config = "c".repeat(3.5 * 1024 * 1024);
    const own = [
      "/home/u/.claude/settings.json",
      "/home/u/.claude.json",
      "/work/.claude/settings.json",
      "/work/.claude/settings.local.json",
      "/work/.mcp.json",
    ];
    const f = await fixture(1024 * 1024, [], false, {
      cwd: "/work",
      home: "/home/u",
      seed(fs) {
        workspace(fs);
        for (const path of own) fs.writeFileSync(path, config);
      },
    });
    try {
      expect(f.prefetchedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      const readable = own.filter((path) => {
        try {
          return f.fs.readFileSync(path, "utf8").length === config.length;
        } catch {
          return false;
        }
      });
      expect(readable).toHaveLength(4);
      // The limit that failed is the pinned total: four files pinned and the fifth's bytes.
      expect(f.traces).toContainEqual({
        kind: "too-large",
        bytes: 5 * config.length,
        limit: 16 * 1024 * 1024,
      });
    } finally {
      await f.close();
    }
  });

  it("lets a sync-read file's pin go once it grows too large, so another one fits", async () => {
    const config = "c".repeat(3.5 * 1024 * 1024);
    const f = await fixture(1024 * 1024, [], false, {
      cwd: "/work",
      home: "/home/u",
      seed(fs) {
        workspace(fs);
        for (const path of [
          "/home/u/.claude/settings.json",
          "/home/u/.claude/settings.local.json",
          "/work/.claude/settings.json",
          "/work/.claude/settings.local.json",
        ])
          fs.writeFileSync(path, config);
        fs.writeFileSync("/home/u/.claude.json", "g".repeat(1.5 * 1024 * 1024));
      },
    });
    try {
      // 14 MiB and the global config's 1.5 MiB are pinned. The config grows past 4 MiB, and a
      // 1.9 MiB .mcp.json fits under 16 MiB, beside git's few bytes, only if that pin was let go.
      await f.files.beforeRemote();
      f.canonical.writeFileSync("/home/u/.claude.json", "g".repeat(5 * 1024 * 1024));
      const mcp = "m".repeat(1.9 * 1024 * 1024);
      f.canonical.writeFileSync("/work/.mcp.json", mcp);
      await f.files.afterRemote();
      expect(f.fs.readFileSync("/work/.mcp.json", "utf8")).toBe(mcp);
      expect(() => f.fs.readFileSync("/home/u/.claude.json")).toThrow(
        expect.objectContaining({ code: "EIO" }),
      );
    } finally {
      await f.close();
    }
  });

  it(
    "indexes a Computer the size of the replayed session in a few calls",
    { timeout: 180_000 },
    async () => {
      // The replayed session's view: 19,092 entries.
      const f = await open((fs) => {
        workspace(fs);
        for (let directory = 0; directory < 40; directory++) fs.mkdirSync(`/work/d${directory}`);
        for (let index = 0; index < 19_040; index++)
          fs.writeFileSync(`/work/d${index % 40}/f${index}`, "");
      }, 32_768);
      try {
        expect(f.calls.metadata).toBeLessThanOrEqual(10);
        expect(f.calls.prefetch).toBe(Object.keys(files).length);
        expect(f.fs.readFileSync("/work/.git/HEAD", "utf8")).toBe(files["/work/.git/HEAD"]);
      } finally {
        await f.close();
      }
    },
  );
});
