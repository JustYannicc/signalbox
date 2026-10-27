import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import type { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import type {
  HarnessFilesStoreCommand,
  HarnessFilesStoreResult,
} from "../durableState/files/contracts.ts";
import { prepareCheckpoint } from "../durableState/files/content.ts";

type ReadCheckpointCommand = Extract<HarnessFilesStoreCommand, { readonly type: "readCheckpoint" }>;

export class HarnessCProductFilesError extends Error {
  readonly _tag = "HarnessCProductFilesError";
}

/** Reads A's committed files through its publisher, never B's replacement publisher. */
export async function readHarnessCProductFilesCheckpoint(input: {
  readonly store: Pick<HarnessFilesStoreObject, "execute">;
  readonly runId: string;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly checkpointId: string;
  readonly manifestRevision: string;
}): Promise<HarnessFilesStoreResult> {
  const command: ReadCheckpointCommand = {
    type: "readCheckpoint",
    runId: input.runId,
    publisher: input.publisher,
    checkpointId: input.checkpointId,
  };
  let result: HarnessFilesStoreResult;
  try {
    result = await input.store.execute(command);
  } catch (cause) {
    throw new HarnessCProductFilesError("A's committed files checkpoint could not be read.", {
      cause,
    });
  }

  if (
    result.action !== "read" ||
    result.checkpoint.checkpointId !== input.checkpointId ||
    result.checkpoint.manifestSha256 !== input.manifestRevision
  )
    throw new HarnessCProductFilesError(
      "A's files checkpoint does not match the requested checkpoint identity.",
    );

  validateFiles(result.files);
  const verified = await prepareCheckpoint({
    checkpointId: input.checkpointId,
    parentCheckpointId: result.parentCheckpointId,
    files: result.files,
  });
  if (verified.manifestSha256 !== input.manifestRevision)
    throw new HarnessCProductFilesError("A's files checkpoint bytes or modes changed.");
  return {
    ...result,
    files: result.files.map((file) => ({ ...file, bytes: file.bytes.slice() })),
  };
}

export function validateHarnessCProductFiles(files: HarnessFilesStoreResult["files"]): void {
  validateFiles(files);
}

function validateFiles(files: HarnessFilesStoreResult["files"]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (
      file.path.length === 0 ||
      file.path.includes("\0") ||
      file.path.startsWith("/") ||
      file.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o7777 ||
      !(file.bytes instanceof Uint8Array) ||
      paths.has(file.path)
    )
      throw new HarnessCProductFilesError(
        "A's files checkpoint contains an invalid or duplicate file entry.",
      );
    paths.add(file.path);
  }

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let parent = "";
    for (const part of parts.slice(0, -1)) {
      parent = parent.length === 0 ? part : `${parent}/${part}`;
      if (paths.has(parent))
        throw new HarnessCProductFilesError(
          "A's files checkpoint contains a file where another path needs a directory.",
        );
    }
  }
}
