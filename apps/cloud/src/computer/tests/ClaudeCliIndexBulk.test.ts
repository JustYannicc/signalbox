// @effect-diagnostics nodeBuiltinImport:off - The bound is on this thread's own CPU time.
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { CliFileMetadata } from "../../harness/CliFileWorkingSet.ts";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";
import { installMachineTree, type MachinePath } from "./helpers/machineTree.ts";
import { referenceCliMetadata } from "./helpers/referenceIndex.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

type Fixture = Awaited<ReturnType<typeof fixture>>;

const PAGE = 2048;

/** The index the way the CLI reads it, a page per call to Computer. */
async function index(f: Fixture) {
  const entries: CliFileMetadata[] = [];
  const pages: { readonly entries: number; readonly cpuMs: number }[] = [];
  let cursor: number | null = 0;
  let revision: number | undefined;
  while (cursor !== null) {
    const started = threadCpuMs();
    const page = await f.kernel.metadata(cursor, revision);
    pages.push({ entries: page.entries.length, cpuMs: threadCpuMs() - started });
    revision = page.revision;
    entries.push(...page.entries);
    cursor = page.next;
  }
  return { entries, pages };
}

const threadCpuMs = () => {
  const usage = NodeProcess.threadCpuUsage();
  return (usage.user + usage.system) / 1000;
};

/** The machine image: tools, links, hard links, directories the CLI may not read or search. */
const MACHINE: MachinePath[] = [
  { path: "/usr/bin/tool", mode: 0o755, uid: 1000 },
  { path: "/usr/bin/bash", mode: 0o755 },
  { path: "/usr/bin/sh", target: "bash" },
  { path: "/usr/lib/tool", target: "/usr/bin/tool" },
  { path: "/usr/lib/one", ino: 41 },
  { path: "/usr/lib/two", ino: 41 },
  { path: "/root", type: "directory", mode: 0o700 },
  { path: "/root/secret" },
  { path: "/srv/listed", type: "directory", mode: 0o744 },
  { path: "/srv/listed/x" },
  { path: "/srv/listed/y" },
  { path: "/srv/bare", type: "directory", mode: 0o744 },
  { path: "/etc", type: "directory", uid: 1000 },
  { path: "/etc/kept" },
  { path: "/etc/gone", uid: 1000 },
  { path: "/merged", type: "directory", uid: 1000 },
  { path: "/merged/lower" },
  // The kernel answers this path itself, whatever the image holds there.
  { path: "/dev/null" },
];

describe("the CLI's startup index", () => {
  it.each([true, false])(
    "reads exactly what the path-by-path walk reads, posix %s",
    async (posix) => {
      let files: KernelFileSystem | undefined;
      const f = await fixture(128, ["/sync"], posix, {
        metadataLimit: 4096,
        seed(fs, kernel) {
          files = kernel;
          installMachineTree(kernel, MACHINE);
          // Computer's own files over the image: a copied-up tool, a deleted file, a merged
          // directory, and a home with a link and a directory its owner shut.
          fs.writeFileSync("/usr/bin/tool", "rebuilt");
          // A machine file is deleted by copying it up and unlinking the copy, which leaves a whiteout.
          fs.writeFileSync("/etc/gone", "copied");
          fs.unlinkSync("/etc/gone");
          fs.writeFileSync("/merged/upper", "mine");
          fs.mkdirSync("/home/u/.claude", { recursive: true });
          fs.writeFileSync("/home/u/.claude/settings.json", "{}");
          fs.symlinkSync("../u/.claude", "/home/u/link");
          fs.mkdirSync("/home/u/private");
          fs.writeFileSync("/home/u/private/note", "x");
          if (posix) fs.chmodSync("/home/u/private", 0o000);
        },
      });
      try {
        const { entries } = await index(f);
        expect(entries).toEqual(
          await referenceCliMetadata(files!, 4096, new AbortController().signal),
        );
        const at = (path: string) => entries.find((entry) => entry.path === path);
        expect(at("/usr/bin/tool")?.stat.size).toBe(7n);
        expect(at("/usr/bin/sh")?.target).toBe("bash");
        expect(at("/usr/lib/one")?.stat.ino).toBe(at("/usr/lib/two")?.stat.ino);
        expect(at("/etc/kept")).toBeDefined();
        expect(at("/etc/gone")).toBeUndefined();
        expect([at("/merged/lower"), at("/merged/upper")]).not.toContain(undefined);
        expect(at("/home/u/link")?.target).toBe("../u/.claude");
        if (!posix) return;
        expect(at("/root")?.directoryDenial).toEqual({ read: "EACCES" });
        expect(at("/root/secret")).toBeUndefined();
        expect(at("/srv/listed")).toMatchObject({
          children: ["x", "y"],
          directoryDenial: { search: "EACCES" },
        });
        expect(at("/srv/bare")?.directoryDenial).toBeUndefined();
        expect(at("/home/u/private")?.directoryDenial).toEqual({ read: "EACCES" });
      } finally {
        await f.close();
      }
    },
  );

  it(
    "reads a 19k-entry tree a page per call, with no per-path syscall and a handful of queries",
    {
      timeout: 60_000,
    },
    async () => {
      const counted = { paths: 0, queries: 0, on: false };
      const f = await fixture(128, ["/sync"], true, {
        metadataLimit: 32_768,
        seed(fs, files) {
          // The real image's shape: 16,880 entries, about 2,000 of them directories, 1,210 links.
          installMachineTree(files, machineImage());
          for (let project = 0; project < 40; project++) {
            fs.mkdirSync(`/home/u/.claude/projects/p${project}`, { recursive: true });
            for (let file = 0; file < 54; file++)
              fs.writeFileSync(`/home/u/.claude/projects/p${project}/s${file}.jsonl`, "{}\n");
          }
          for (const name of ["lstatAsync", "readdirAsync"] as const) {
            const call = files[name].bind(files) as (...args: never[]) => unknown;
            Object.assign(files, {
              [name]: (...args: never[]) => {
                if (counted.on) counted.paths++;
                return call(...args);
              },
            });
          }
        },
      });
      try {
        const exec = f.sql.exec.bind(f.sql);
        f.sql.exec = (query, ...bindings) => {
          if (counted.on && query.includes("kernel_fs_")) counted.queries++;
          return exec(query, ...bindings);
        };
        const traced = f.traceRows().length;
        counted.on = true;
        const started = threadCpuMs();
        const { entries, pages } = await index(f);
        const cpuMs = threadCpuMs() - started;
        counted.on = false;
        expect(entries.length).toBeGreaterThan(19_000);
        expect(counted.paths).toBe(0);
        // The revision stamp, then the snapshot: the root, every name, whiteouts, staged files.
        expect(counted.queries).toBeLessThanOrEqual(8);
        expect(pages.length).toBeLessThanOrEqual(Math.ceil(entries.length / PAGE) + 1);
        expect(pages.slice(0, -1).every((page) => page.entries === PAGE)).toBe(true);
        // Locally the whole index takes a few hundred milliseconds; the walk it replaced took
        // tens of seconds in one call. The bounds leave room for a loaded machine.
        expect(cpuMs).toBeLessThan(2_000);
        expect(Math.max(...pages.map((page) => page.cpuMs))).toBeLessThan(1_000);
        const rows = f
          .traceRows()
          .slice(traced)
          .filter((row) => row.source === "kernel");
        expect(rows.map(({ event }) => `${event.kind}:${event.phase}:${event.cursor}`)).toEqual(
          pages
            .filter((page) => page.entries > 0)
            .flatMap((_, at) => [`index-page:start:${at * PAGE}`, `index-page:end:${at * PAGE}`]),
        );
        expect(
          rows
            .filter(({ event }) => event.phase === "end")
            .reduce((sum, { event }) => sum + event.entries, 0),
        ).toBe(entries.length);
      } finally {
        await f.close();
      }
    },
  );

  it("starts over when a page fails, rather than resuming a broken walk", async () => {
    let failing = false;
    const f = await fixture(128, ["/sync"], false, {
      metadataLimit: 8192,
      seed(fs, files) {
        fs.mkdirSync("/bulk");
        for (let file = 0; file < 3000; file++) fs.writeFileSync(`/bulk/f${file}`, "");
        fs.mkdirSync("/z");
        const metadataTree = files.metadataTree.bind(files);
        files.metadataTree = (maxEntries) => {
          const tree = metadataTree(maxEntries);
          if (tree === undefined) return undefined;
          const readdir = tree.readdir.bind(tree);
          tree.readdir = async (directory, signal) => {
            if (failing && directory.path === "/z")
              throw Object.assign(new Error("lost"), { code: "EIO" });
            return readdir(directory, signal);
          };
          return tree;
        };
      },
    });
    try {
      failing = true;
      const first = await f.kernel.metadata(0);
      expect(first.entries).toHaveLength(PAGE);
      await expect(f.kernel.metadata(PAGE, first.revision)).rejects.toMatchObject({ code: "EIO" });
      await expect(f.kernel.metadata(PAGE, first.revision)).rejects.toMatchObject({
        code: "ESTALE",
      });
      failing = false;
      const { entries } = await index(f);
      expect(entries.map(({ path }) => path)).toContain("/z");
    } finally {
      await f.close();
    }
  });
});

/** 16,880 entries shaped like the real machine image: packages of directories, files, links. */
function machineImage(): MachinePath[] {
  const paths: MachinePath[] = [];
  const directories: string[] = [];
  for (let pkg = 0; pkg < 40; pkg++)
    for (let directory = 0; directory < 49; directory++) {
      const path = `/usr/share/p${pkg}/d${directory}`;
      directories.push(path);
      paths.push({ path, type: "directory" });
    }
  // With the root, /usr, /usr/share and the 40 packages, 16,880 in all.
  for (let file = 0; file < 13_667; file++)
    paths.push({ path: `${directories[file % directories.length]}/f${file}` });
  for (let link = 0; link < 1_210; link++)
    paths.push({ path: `${directories[link % directories.length]}/l${link}`, target: `f${link}` });
  return paths;
}
