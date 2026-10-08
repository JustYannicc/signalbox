import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import type { MountedShortcut } from "./RunnerShortcuts.ts";

/**
 * The instructions a thread's agents follow when its drive has shortcuts
 * (#142). Neither harness looks for guidance in folders it only works in:
 * Codex reads the `AGENTS.md` chain from its project root down to the working
 * directory, and Claude Code reads `CLAUDE.md` and (as the machine configures
 * it, `RunnerModelAccess.ts`) `AGENTS.md` up the same way. So the mounted
 * drives' instructions are bundled into one generated `AGENTS.md` in the
 * folder *above* the drive's checkout, which both harnesses read before the
 * drive's own, and Codex treats as its project root (`ROOT_MARKER`). It sits
 * outside the drive's repository, so it is never saved, and the drive's own
 * `AGENTS.md` and `CLAUDE.md` stay exactly as they are.
 *
 * Each block is a mounted drive's root `AGENTS.override.md` or `AGENTS.md`
 * (the file Codex itself would pick), labeled with the folder it applies to,
 * in the drive's shortcut order. With no such files the bundle is removed.
 *
 * Codex silently cuts its instruction chain at `project_doc_max_bytes`; the
 * machine sets that to `INSTRUCTIONS_MAX_BYTES`, and a bundle that would not
 * fit beside the drive's own file fails the turn with a message instead.
 *
 * Harnesses read instructions when a session starts, not every turn. The
 * bundle's text is its version: when it changes, the Runner restarts the
 * harness session, and its native resume replaces the old instructions.
 */

/** Codex's `project_doc_max_bytes` on the machine. */
export const INSTRUCTIONS_MAX_BYTES = 64 * 1024;

/** Marks the folder above the checkout as Codex's project root (`project_root_markers`). */
export const ROOT_MARKER = ".signalbox-root";

const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md"] as const;

export class RunnerInstructionsError extends Schema.TaggedError<RunnerInstructionsError>()(
  "RunnerInstructionsError",
  { message: Schema.String },
) {}

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;

const HEADER = [
  "# Instructions from shortcuts",
  "",
  "Signalbox wrote this file from the drive's shortcuts: folders that show another drive,",
  "read-only, with that drive's own history. Each section is that drive's instructions and",
  "applies only to files under its folder. The drive's own instructions apply everywhere else.",
].join("\n");

export const makeRunnerInstructions = Effect.fn("makeRunnerInstructions")(function* (input: {
  /** The thread's working directory: the drive's checkout. */
  readonly cwd: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.dirname(input.cwd);
  const bundleFile = path.join(root, "AGENTS.md");

  /** The instruction file Codex would read in `dir`, or null. */
  const instructionsIn = (dir: string) =>
    Effect.gen(function* () {
      for (const name of INSTRUCTION_FILES) {
        const file = path.join(dir, name);
        const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
        if (text !== null && text.trim().length > 0) return { name, text };
      }
      return null;
    });

  /**
   * Writes the bundle for `mounted`, or removes it when there is nothing to
   * bundle, and answers its text: the instructions' version.
   */
  const compose = (mounted: ReadonlyArray<MountedShortcut>) =>
    Effect.gen(function* () {
      const marker = path.join(root, ROOT_MARKER);
      if (!(yield* fs.exists(marker))) yield* fs.writeFileString(marker, "");
      const sources: Array<{ readonly label: string; readonly bytes: number }> = [];
      const blocks: Array<string> = [];
      for (const shortcut of mounted) {
        const found = yield* instructionsIn(shortcut.dir);
        if (found === null) continue;
        sources.push({
          label: `${shortcut.path}/${found.name}`,
          bytes: new TextEncoder().encode(found.text).byteLength,
        });
        blocks.push(
          [
            `## \`${shortcut.path}/\``,
            "",
            `Applies to \`${shortcut.path}/\` and everything under it (its ${found.name}).`,
            "",
            found.text.trim(),
          ].join("\n"),
        );
      }
      if (blocks.length === 0) {
        yield* fs.remove(bundleFile, { force: true });
        return "";
      }
      const bundle = `${[HEADER, ...blocks].join("\n\n")}\n`;
      const bundleBytes = new TextEncoder().encode(bundle).byteLength;
      const own = yield* instructionsIn(input.cwd);
      const ownBytes = own === null ? 0 : new TextEncoder().encode(own.text).byteLength;
      if (bundleBytes + ownBytes > INSTRUCTIONS_MAX_BYTES) {
        const parts = [
          ...(own === null ? [] : [`${own.name} ${size(ownBytes)}`]),
          ...sources.map((source) => `${source.label} ${size(source.bytes)}`),
        ];
        // Stale instructions must not outlive the turn that refused them.
        yield* fs.remove(bundleFile, { force: true });
        return yield* new RunnerInstructionsError({
          message:
            `This drive's instructions come to ${size(bundleBytes + ownBytes)}, over the ` +
            `${size(INSTRUCTIONS_MAX_BYTES)} agents can load: ${parts.join(", ")}. ` +
            "Shorten them or remove a shortcut, then send the message again.",
        });
      }
      const current = yield* fs.readFileString(bundleFile).pipe(Effect.orElseSucceed(() => null));
      if (current !== bundle) {
        yield* writeFileStringAtomically({ filePath: bundleFile, contents: bundle }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }
      return bundle;
    });

  return { compose, bundleFile };
});

export type RunnerInstructions = Effect.Success<ReturnType<typeof makeRunnerInstructions>>;
