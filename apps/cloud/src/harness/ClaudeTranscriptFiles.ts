import { CLAUDE_STREAM_PREFIX } from "@signalbox/runner-protocol/SessionProtocol";
import { createNodeFs } from "../isolate/NodeFs.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import { KernelFileTransfer, kernelFileTransferManifest } from "../kernel/KernelFileTransfer.ts";
import type { ClaudeTranscriptCapture } from "./ClaudeTranscriptPort.ts";

/** Reads the canonical native transcripts only inside their kernel owner. */
export async function captureClaudeTranscriptFiles(
  files: KernelFileSystem,
  configurationDirectory: string,
  nativeId: string,
  signal: AbortSignal,
): Promise<ClaudeTranscriptCapture> {
  if (!/^[a-zA-Z0-9-]+$/.test(nativeId)) throw new Error("Claude native session id is invalid.");
  const projects = `${configurationDirectory.replace(/\/$/, "")}/projects`;
  const statIfPresent = async (path: string) => {
    try {
      return await files.statAsync(path, signal);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  };
  const matches: string[] = [];
  if (await statIfPresent(projects)) {
    for (const entry of await files.readdirAsync(projects, signal)) {
      const directory = `${projects}/${entry}`;
      const path = `${directory}/${nativeId}.jsonl`;
      const directoryStat = await files.statAsync(directory, signal);
      if (directoryStat.type === "directory" && (await statIfPresent(path))) matches.push(path);
    }
  }
  if (matches.length !== 1) throw new Error("Claude's native transcript is missing or ambiguous.");
  const main = matches[0]!;
  const streams = [{ stream: `${CLAUDE_STREAM_PREFIX}${nativeId}`, path: main }];
  const sidecars = main.slice(0, -".jsonl".length);
  const visit = async (directory: string, relative: string) => {
    for (const name of await files.readdirAsync(directory, signal)) {
      const path = `${directory}/${name}`;
      const subpath = relative === "" ? name : `${relative}/${name}`;
      const stat = await files.lstatAsync(path, signal);
      if (stat.type === "directory") await visit(path, subpath);
      else if (stat.type === "file" && name.endsWith(".jsonl"))
        streams.push({ stream: `${CLAUDE_STREAM_PREFIX}${nativeId}/${subpath}`, path });
    }
  };
  if (await statIfPresent(sidecars)) await visit(sidecars, "");
  await files.prepareLowerPaths(
    streams.map((file) => file.path),
    signal,
  );
  signal.throwIfAborted();
  const fs = createNodeFs(files).fs;
  const captured = streams.map(({ path }) => {
    const bytes = fs.readFileSync(path);
    if (typeof bytes === "string") throw new Error("Claude transcript requires binary bytes.");
    return { path, mode: fs.statSync(path).mode & 0o7777, bytes: Uint8Array.from(bytes) };
  });
  return {
    streams,
    manifest: kernelFileTransferManifest(captured),
    source: new KernelFileTransfer(captured),
  };
}
