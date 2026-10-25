import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelCommandForwarder } from "../../kernel/KernelCommandForwarder.ts";
import {
  CODEX_UNIFIED_EXEC_ENV,
  createCodexLocaleProductComputer,
  loadCodexLocalePrograms,
} from "./CodexLocaleProductComputerFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const programs = loadCodexLocalePrograms();
const blockedMachine: KernelCommandForwarder = {
  async spawn() {
    const empty = () =>
      new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    return {
      stdin: new WritableStream<Uint8Array>(),
      stdout: empty(),
      stderr: empty(),
      exited: Promise.resolve({ exitCode: 126, signal: 0, coreDumped: false }),
      signal: async () => {
        throw new Error("No signal is expected for the blocked machine");
      },
      dispose: async () => {},
    };
  },
};
const locales = ["", "C", "POSIX", "C.UTF-8", "C.utf8"];
const denied = [
  {
    name: "sticky directory owned by another user",
    directory: { mode: 0o1777, uid: 2000, gid: 2000 },
    file: { mode: 0o644, uid: 2000, gid: 2000 },
  },
  ...[0o2755, 0o4755, 0o6755].map((mode) => ({
    name: `special mode ${mode.toString(8)}`,
    directory: { mode: 0o755, uid: 1000, gid: 1000 },
    file: { mode, uid: 1000, gid: 1000 },
  })),
  {
    name: "setgid with a foreign group",
    directory: { mode: 0o755, uid: 1000, gid: 1000 },
    file: { mode: 0o2755, uid: 1000, gid: 2000 },
  },
];

type Fixture = ReturnType<typeof createCodexLocaleProductComputer>;

async function run(fixture: Fixture, script: string, locale: string) {
  const child = await fixture.computer.exec(
    {
      executable: "/bin/bash",
      argv: ["/bin/bash", "--noprofile", "--norc", "-c", script],
      cwd: "/workspace",
      env: { ...CODEX_UNIFIED_EXEC_ENV, LANG: locale, LC_CTYPE: locale, LC_ALL: locale },
    },
    new AbortController().signal,
    undefined,
  );
  try {
    const writer = child.stdin.getWriter();
    try {
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode: exit.exitCode };
  } finally {
    await child.dispose();
  }
}

function snapshot(fixture: Fixture) {
  const file = fixture.filesystem.stat("/workspace/proof.txt");
  return {
    inode: file.ino,
    metadata: file.posix,
    directory: fixture.filesystem.stat("/workspace").posix,
    entries: fixture.filesystem.readdir("/workspace").sort(),
    bytes: [...fixture.readFile("/workspace/proof.txt")],
  };
}

describe.skipIf(programs === undefined)("public sed metadata qualification", () => {
  it.each(
    locales.flatMap((locale) =>
      denied.flatMap((metadata) =>
        ["-i", "-i.bak"].map((option) => ({ locale, option, ...metadata })),
      ),
    ),
  )("escalates $name with $option under '$locale' before effects", async (entry) => {
    if (programs === undefined) throw new Error("Pinned Codex locale programs are unavailable");
    const fixture = createCodexLocaleProductComputer(programs, {
      ...entry,
      machine: blockedMachine,
    });
    try {
      const before = snapshot(fixture);
      const result = await run(
        fixture,
        `sed ${entry.option} 's/BEFORE/AFTER/' proof.txt`,
        entry.locale,
      );
      expect({ result, machineCalls: fixture.machineCalls, after: snapshot(fixture) }).toEqual({
        result: { stdout: "", stderr: "", exitCode: 126 },
        machineCalls: [
          expect.objectContaining({
            executable: "/bin/sed",
            argv: ["sed", entry.option, "s/BEFORE/AFTER/", "proof.txt"],
            cwd: "/workspace",
            env: expect.objectContaining({
              ...CODEX_UNIFIED_EXEC_ENV,
              LANG: entry.locale,
              LC_CTYPE: entry.locale,
              LC_ALL: entry.locale,
            }),
          }),
        ],
        after: before,
      });
      expect(fixture.loaderGuestPrograms).toEqual(["bash"]);
    } finally {
      await fixture.close();
    }
  });

  it.each(
    locales.flatMap((locale) =>
      [
        { directoryUid: 1000, fileUid: 2000 },
        { directoryUid: 2000, fileUid: 1000 },
      ].map((owners) => ({ locale, ...owners })),
    ),
  )(
    "allows sticky directory owner $directoryUid/file owner $fileUid under '$locale'",
    async (entry) => {
      if (programs === undefined) throw new Error("Pinned Codex locale programs are unavailable");
      const fixture = createCodexLocaleProductComputer(programs, {
        directory: { mode: 0o1777, uid: entry.directoryUid, gid: 2000 },
        file: { mode: 0o644, uid: entry.fileUid, gid: 1000 },
      });
      try {
        expect(await run(fixture, "sed -i 's/BEFORE/AFTER/' proof.txt", entry.locale)).toEqual({
          stdout: "",
          stderr: "",
          exitCode: 0,
        });
        expect(fixture.readFile("/workspace/proof.txt")).toEqual(
          new TextEncoder().encode("AFTER\n"),
        );
        expect(fixture.machineCalls).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(denied)("keeps non-editing sed local for $name", async (entry) => {
    if (programs === undefined) throw new Error("Pinned Codex locale programs are unavailable");
    const fixture = createCodexLocaleProductComputer(programs, entry);
    try {
      const before = snapshot(fixture);
      expect(await run(fixture, "sed 's/BEFORE/AFTER/' proof.txt", "C.UTF-8")).toEqual({
        stdout: "AFTER\n",
        stderr: "",
        exitCode: 0,
      });
      expect(snapshot(fixture)).toEqual(before);
      expect(fixture.machineCalls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it.each(locales)(
    "uses the symlink owner for sticky-directory edits under '%s'",
    async (locale) => {
      if (programs === undefined) throw new Error("Pinned Codex locale programs are unavailable");
      const fixture = createCodexLocaleProductComputer(programs, {
        directory: { mode: 0o1777, uid: 2000, gid: 2000 },
        file: { mode: 0o644, uid: 2000, gid: 2000 },
        machine: blockedMachine,
      });
      try {
        fixture.filesystem.symlink("proof.txt", "/workspace/link.txt");
        expect(await run(fixture, "sed -i 's/BEFORE/AFTER/' link.txt", locale)).toEqual({
          stdout: "",
          stderr: "",
          exitCode: 0,
        });
        expect(fixture.filesystem.lstat("/workspace/link.txt").type).toBe("file");
        expect(fixture.readFile("/workspace/link.txt")).toEqual(
          new TextEncoder().encode("AFTER\n"),
        );
        expect(fixture.readFile("/workspace/proof.txt")).toEqual(
          new TextEncoder().encode("BEFORE\n"),
        );
        expect(fixture.machineCalls).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );
});
