// @effect-diagnostics globalTimers:off - Failure deadlines bound the standalone Chokidar fixture process.
import * as NodeModule from "node:module";
import type { FSWatcher } from "chokidar";
import { nodeFsWatchFixture } from "./nodeFsWatchFixture.ts";

const fixture = nodeFsWatchFixture();
const nativeRequire = NodeModule.createRequire(import.meta.url);
const nativeFs = nativeRequire("node:fs") as Record<string, unknown>;
const nativePromises = nativeRequire("node:fs/promises") as Record<string, unknown>;
const fs = fixture.fs as unknown as Record<string, unknown>;
const promises = fixture.fs.promises as unknown as Record<string, unknown>;
const watchFilePaths: string[] = [];

for (const name of ["stat", "watchFile", "unwatchFile", "watch"]) nativeFs[name] = fs[name];
for (const name of ["stat", "lstat", "readdir", "realpath", "open"])
  nativePromises[name] = promises[name];
NodeModule.syncBuiltinESMExports();

const events: Array<{ event: string; path: string }> = [];
let ready = false;
let firstWatchFileError: ChokidarProbeResult["firstWatchFileError"];
let watcher: FSWatcher | undefined;
let finished = false;

interface ChokidarProbeResult {
  ready: boolean;
  events: Array<{ event: string; path: string }>;
  watchFilePaths: string[];
  firstWatchFileError?: { code?: string; syscall?: string; path?: string } | undefined;
  closed: boolean;
}

function errorDetails(error: unknown): NonNullable<ChokidarProbeResult["firstWatchFileError"]> {
  if (typeof error !== "object" || error === null) return {};
  const details = error as Record<string, unknown>;
  return {
    ...(typeof details.code === "string" ? { code: details.code } : {}),
    ...(typeof details.syscall === "string" ? { syscall: details.syscall } : {}),
    ...(typeof details.path === "string" ? { path: details.path } : {}),
  };
}

function finish(result: ChokidarProbeResult): void {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  fixture.close();
}

function waitForEvent(event: string, path: string): Promise<void> {
  if (events.some((seen) => seen.event === event && seen.path === path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${event} ${path}`)),
      1_500,
    );
    const onEvent = (actualEvent: string, actualPath: string) => {
      if (actualEvent !== event || actualPath !== path) return;
      clearTimeout(timeout);
      watcher?.off("all", onEvent);
      resolve();
    };
    watcher?.on("all", onEvent);
  });
}

async function main(): Promise<void> {
  fixture.fs.mkdirSync("/skills");
  fixture.fs.writeFileSync("/skills/one.md", "before");
  // Report the synchronous adapter failure before Chokidar can retry the root path.
  const originalWatchFile = fs.watchFile as (...args: unknown[]) => unknown;
  fs.watchFile = (...args: unknown[]) => {
    watchFilePaths.push(String(args[0]));
    try {
      return originalWatchFile(...args);
    } catch (error) {
      firstWatchFileError ??= errorDetails(error);
      void watcher?.close().then(() => {
        finish({ ready, events, watchFilePaths, firstWatchFileError, closed: true });
        process.exit(0);
      });
      throw error;
    }
  };
  nativeFs.watchFile = fs.watchFile;
  NodeModule.syncBuiltinESMExports();

  // Chokidar and readdirp destructure builtin fs exports during module evaluation.
  const { watch } = await import("chokidar");
  watcher = watch("/skills", {
    usePolling: true,
    interval: 10,
    binaryInterval: 10,
    atomic: false,
    ignorePermissionErrors: true,
  });
  watcher.on("all", (event, path) => {
    if (event === "add" || event === "change" || event === "unlink") events.push({ event, path });
  });
  watcher.on("error", (error) => {
    firstWatchFileError ??= errorDetails(error);
  });
  watcher.once("ready", () => {
    ready = true;
  });

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await new Promise<void>((resolve) => watcher?.once("ready", resolve));
        if (!events.some((event) => event.event === "add" && event.path === "/skills/one.md"))
          throw new Error("Chokidar did not report the initial file before ready");
        const changed = waitForEvent("change", "/skills/one.md");
        fixture.fs.writeFileSync("/skills/one.md", "after");
        await changed;
        const added = waitForEvent("add", "/skills/two.md");
        fixture.fs.writeFileSync("/skills/two.md", "new");
        await added;
        const unlinked = waitForEvent("unlink", "/skills/one.md");
        fixture.fs.unlinkSync("/skills/one.md");
        await unlinked;
        await watcher?.close();
        finish({ ready, events, watchFilePaths, firstWatchFileError, closed: true });
      })(),
      new Promise<never>(
        (_, reject) =>
          (watchdog = setTimeout(
            () => reject(new Error("Chokidar probe exceeded its bound")),
            2_000,
          )),
      ),
    ]);
  } catch (error) {
    await watcher?.close();
    finish({ ready, events, watchFilePaths, firstWatchFileError, closed: true });
    if (firstWatchFileError === undefined) throw error;
  } finally {
    clearTimeout(watchdog);
  }
}

void main();
