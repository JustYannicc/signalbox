import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { captureOutput, safeOutputError, streamLabel } from "./output/capture.ts";
import type {
  Descriptor,
  OutputAlias,
  OutputCapture,
  OutputPath,
  OutputPreparationOptions,
  OutputResult,
  PreparedOutputCapture,
} from "./output/types.ts";

export type { OutputResult, PreparedOutputCapture } from "./output/types.ts";

export function prepareOutputCapture(options: OutputPreparationOptions): PreparedOutputCapture {
  const { processKey, childId, spawn, files: filesFactory } = options;
  const captures: OutputCapture[] = [];
  let files: KernelFileSystem | undefined;
  const aliases: OutputAlias[] = [];

  for (const stream of ["stdout", "stderr"] as const) {
    const fd = spawn.stdio[stream === "stdout" ? 1 : 2];
    if (fd === "ignore") {
      report({ stream, status: "ignored", reason: "stdio-ignore" });
      continue;
    }
    if (fd === "pipe") {
      report({ stream, status: "gap", reason: "pipe-output-not-consumed" });
      continue;
    }

    let descriptor: Descriptor;
    try {
      files ??= filesFactory();
      descriptor = files.descriptors.get(fd);
    } catch (error) {
      report({
        stream,
        fd,
        status: "gap",
        reason: "descriptor-unavailable",
        error: safeOutputError(error),
      });
      continue;
    }
    if (
      descriptor.kind !== "file" ||
      descriptor.mount === undefined ||
      descriptor.inode === undefined
    ) {
      report({ stream, fd, status: "no-file", reason: "numeric-descriptor-is-not-a-mounted-file" });
      continue;
    }

    try {
      const stat = files!.fstat(fd);
      aliases.push({ stream, fd, descriptor, fstat: { size: stat.size, mtimeNs: stat.mtimeNs } });
      report({
        stream,
        fd,
        status: "descriptor-pinned-pending",
        mountId: descriptor.mount.id,
        mountPath: descriptor.mount.path,
        inode: descriptor.inode.toString(),
        pathComponents:
          descriptor.pathComponents === undefined ? null : [...descriptor.pathComponents],
        fstatBeforeSpawn: { size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString() },
      });
    } catch (error) {
      report({
        stream,
        fd,
        status: "gap",
        reason: "descriptor-fstat-failed",
        mountId: descriptor.mount.id,
        mountPath: descriptor.mount.path,
        inode: descriptor.inode.toString(),
        pathComponents:
          descriptor.pathComponents === undefined ? null : [...descriptor.pathComponents],
        error: safeOutputError(error),
      });
    }
  }

  for (const alias of aliases) {
    let capture = captures.find(
      (candidate) =>
        candidate.mount === alias.descriptor.mount && candidate.inode === alias.descriptor.inode,
    );
    const path: OutputPath = {
      fd: alias.fd,
      pathComponents:
        alias.descriptor.pathComponents === undefined ? null : [...alias.descriptor.pathComponents],
    };
    if (capture !== undefined) {
      capture.streams.push(alias.stream);
      capture.paths.push(path);
      continue;
    }

    capture = {
      outputId: `${childId}:${alias.stream}`,
      streams: [alias.stream],
      mount: alias.descriptor.mount!,
      inode: alias.descriptor.inode!,
      storage: alias.descriptor.mount!.storage,
      paths: [path],
      initialStats: [],
    };
    captures.push(capture);
  }

  for (const capture of captures.slice()) {
    capture.outputId = `${childId}:${streamLabel(capture.streams)}`;
    for (const alias of aliases) {
      if (alias.descriptor.mount === capture.mount && alias.descriptor.inode === capture.inode) {
        capture.initialStats.push({ fd: alias.fd, ...alias.fstat });
      }
    }

    try {
      const retained = capture.storage.retain(capture.inode);
      if (isPromiseLike(retained)) {
        const release = Promise.resolve(retained)
          .then(() => capture.storage.release(capture.inode))
          .catch((error: unknown) => options.onFailure("capture-output", capture.outputId, error));
        options.track(release);
        report({
          outputId: capture.outputId,
          streams: capture.streams,
          streamLabel: streamLabel(capture.streams),
          status: "gap",
          reason: "async-retain-unsupported",
          mountId: capture.mount.id,
          mountPath: capture.mount.path,
          inode: capture.inode.toString(),
          paths: capture.paths,
        });
        captures.splice(captures.indexOf(capture), 1);
        continue;
      }
      report({
        outputId: capture.outputId,
        streams: capture.streams,
        streamLabel: streamLabel(capture.streams),
        status: "prepared",
        mountId: capture.mount.id,
        mountPath: capture.mount.path,
        inode: capture.inode.toString(),
        paths: capture.paths,
        fstatBeforeSpawn: capture.initialStats.map((stat) => ({
          fd: stat.fd,
          size: stat.size.toString(),
          mtimeNs: stat.mtimeNs.toString(),
        })),
      });
    } catch (error) {
      options.onFailure("capture-output", capture.outputId, error);
      report({
        outputId: capture.outputId,
        streams: capture.streams,
        streamLabel: streamLabel(capture.streams),
        status: "gap",
        reason: "inode-retain-failed",
        mountId: capture.mount.id,
        mountPath: capture.mount.path,
        inode: capture.inode.toString(),
        paths: capture.paths,
        error: safeOutputError(error),
      });
      captures.splice(captures.indexOf(capture), 1);
    }
  }

  let finished = false;
  return {
    captureAfterClose: async () => {
      if (finished) return [];
      finished = true;
      return Promise.all(
        captures.map(async (capture) => {
          await Promise.resolve();
          return captureOutput(capture, options);
        }),
      );
    },
    releaseWithoutCapture: async (reason) => {
      if (finished) return [];
      finished = true;
      return Promise.all(captures.map((capture) => releaseCapture(capture, reason)));
    },
  };

  function report(fields: Readonly<Record<string, unknown>>) {
    const result = fields as OutputResult;
    options.remember(result);
    options.emit({ ...fields, processKey, childId, eventKind: "output" });
  }

  async function releaseCapture(capture: OutputCapture, reason: string): Promise<OutputResult> {
    let releaseError: unknown;
    try {
      await capture.storage.release(capture.inode);
    } catch (error) {
      releaseError = error;
      options.onFailure("capture-output", capture.outputId, error);
    }
    const result: OutputResult = {
      outputId: capture.outputId,
      streams: capture.streams,
      streamLabel: streamLabel(capture.streams),
      status: "gap",
      reason,
      processKey,
      childId,
      mountId: capture.mount.id,
      mountPath: capture.mount.path,
      inode: capture.inode.toString(),
      paths: capture.paths,
      ...(releaseError === undefined ? {} : { releaseError: safeOutputError(releaseError) }),
    };
    options.remember(result);
    options.emit({ ...result, eventKind: "output" });
    return result;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
