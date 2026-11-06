import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const O_PATH = 0x200000;
const O_DIRECTORY = 0x10000;
const O_NOFOLLOW = 0x20000;

describe("CLI filesystem identity", () => {
  // Claude Code's task output pin: open the nearest existing directory, ask the kernel where that
  // descriptor is, create each missing directory through it, and check each new one the same way.
  it("agrees on where and what a tasks directory is, as the CLI pins it and a child writes in it", async () => {
    const f = await fixture(1024, [], false, {
      seed(fs) {
        fs.mkdirSync("/tmp/claude-1000", { recursive: true });
      },
    });
    try {
      const root = await f.fs.promises.open("/tmp/claude-1000", O_PATH | O_DIRECTORY);
      expect(await f.fs.promises.readlink(`/proc/self/fd/${root.fd}`)).toBe("/tmp/claude-1000");
      let parent = root;
      let resolved = "/tmp/claude-1000";
      for (const name of ["-work", "session", "tasks"]) {
        await f.fs.promises.mkdir(`/proc/self/fd/${parent.fd}/${name}`);
        const next = await f.fs.promises.open(
          `/proc/self/fd/${parent.fd}/${name}`,
          O_PATH | O_DIRECTORY | O_NOFOLLOW,
        );
        await parent.close();
        parent = next;
        resolved = `${resolved}/${name}`;
        expect(await f.fs.promises.readlink(`/proc/self/fd/${next.fd}`)).toBe(resolved);
      }
      const tasks = parent;
      const check = async () => {
        const [held, named] = await Promise.all([tasks.stat(), f.fs.promises.lstat(resolved)]);
        expect(held.nlink).toBeGreaterThan(0);
        expect(named.isDirectory()).toBe(true);
        expect([named.dev, named.ino]).toEqual([held.dev, held.ino]);
        const sync = f.fs.lstatSync(resolved);
        expect([sync.dev, sync.ino]).toEqual([held.dev, held.ino]);
        expect(f.fs.realpathSync(resolved)).toBe(resolved);
        expect(await f.fs.promises.realpath(resolved)).toBe(resolved);
      };
      await check();
      // The output file is written through the held descriptor, then by a child.
      await f.fs.promises.writeFile(`/proc/self/fd/${tasks.fd}/t1.output`, "started\n");
      await check();
      await f.files.beforeRemote();
      f.canonical.appendFileSync(`${resolved}/t1.output`, "child output\n");
      await check();
      await f.files.afterRemote();
      await check();
      expect(await f.fs.promises.readFile(`/proc/self/fd/${tasks.fd}/t1.output`, "utf8")).toBe(
        "started\nchild output\n",
      );
      const output = f.fs.lstatSync(`${resolved}/t1.output`);
      const remote = await f.fs.promises.lstat(`/proc/self/fd/${tasks.fd}/t1.output`);
      expect([output.dev, output.ino, output.nlink]).toEqual([
        remote.dev,
        remote.ino,
        remote.nlink,
      ]);
      await tasks.close();
    } finally {
      await f.close();
    }
  });
});
