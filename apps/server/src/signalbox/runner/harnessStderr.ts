import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";

/**
 * What a thread's harness CLIs wrote to stderr, so a turn's failure line can
 * say what the CLI said before it died. Upstream's Codex client drains the
 * app server's stderr and drops it, and a VM's own output is only reachable
 * over SSH. The Runner gives the adapters a spawner that keeps the latest
 * lines (`layerSpawner`); `mark` and `since` scope them to one turn.
 *
 * Claude Code runs through its SDK, which spawns the CLI itself, so only
 * processes started through the spawner (Codex's app server) are kept.
 */

/** Lines kept per thread, across its processes. */
const MAX_LINES = 200;
/** Lines a failure line quotes. */
const QUOTED_LINES = 20;
/** A longer line is cut, and an unterminated one is kept once it gets this long. */
const MAX_LINE_CHARS = 500;

export interface HarnessStderr {
  /** The next line's index: lines from now on are "since" this mark. */
  readonly mark: () => number;
  /** The latest lines written since `mark`, each prefixed with its command. */
  readonly since: (mark: number) => string;
  /** The adapters' spawner, keeping what each process writes to stderr. */
  readonly layerSpawner: Layer.Layer<
    ChildProcessSpawner.ChildProcessSpawner,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >;
}

const nameOf = (
  command: Parameters<ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"]>[0],
) =>
  command._tag === "StandardCommand" ? (command.command.split("/").at(-1) ?? "process") : "process";

export const makeHarnessStderr = (): HarnessStderr => {
  const lines: Array<{ readonly index: number; readonly text: string }> = [];
  let next = 0;

  const keep = (name: string, text: string) => {
    const line = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
    lines.push({ index: next, text: `[${name}] ${line}` });
    next += 1;
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  };

  /** Splits a process's stderr into lines, holding a partial last line until it ends. */
  const tap = (name: string) => {
    const decoder = new TextDecoder();
    let partial = "";
    return {
      chunk: (bytes: Uint8Array) => {
        const complete = (partial + decoder.decode(bytes, { stream: true })).split("\n");
        partial = complete.pop() ?? "";
        for (const line of complete) if (line.trim() !== "") keep(name, line);
        // A CLI writing without newlines never grows this beyond one kept line.
        if (partial.length > MAX_LINE_CHARS) {
          keep(name, partial);
          partial = "";
        }
      },
      end: () => {
        if (partial.trim() !== "") keep(name, partial);
        partial = "";
      },
    };
  };

  const layerSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        Effect.map(spawner.spawn(command), (handle) => {
          const output = tap(nameOf(command));
          return ChildProcessSpawner.makeHandle({
            ...handle,
            stderr: handle.stderr.pipe(
              Stream.tap((bytes) => Effect.sync(() => output.chunk(bytes))),
              Stream.ensuring(Effect.sync(output.end)),
            ),
          });
        }),
      );
    }),
  );

  return {
    mark: () => next,
    since: (mark) =>
      lines
        .filter((line) => line.index >= mark)
        .slice(-QUOTED_LINES)
        .map((line) => line.text)
        .join("\n"),
    layerSpawner,
  };
};
