// @effect-diagnostics nodeBuiltinImport:off - Hash exact output bytes with Node's crypto API.
import * as NodeCrypto from "node:crypto";

import { serializeTraceValue } from "../serialize.ts";
import type { NodeChildProcessTraceOutputMetadata } from "../types.ts";
import type { OutputCapture, OutputPreparationOptions, OutputResult } from "./types.ts";

const chunkSize = 64 * 1024;

export async function captureOutput(
  capture: OutputCapture,
  options: OutputPreparationOptions,
): Promise<OutputResult> {
  const startedWallTimeMs = Date.now();
  const startedMonotonicMs = monotonicNow();
  let bytesCaptured = 0;
  let outputStatus: "captured" | "partial" | "unstable" | "failed" = "failed";
  let stable = false;
  let fullHash = false;
  let sha256: string | undefined;
  let locator: string | undefined;
  let originalSize = 0n;
  let failure: unknown;
  let releaseFailure: unknown;
  let failureOperation: "write-output-chunk" | "finish-output" | "capture-output" =
    "capture-output";

  try {
    const before = await capture.storage.stat(capture.inode);
    if (before.type !== "file" || before.size < 0n)
      throw new Error("Output inode is not a readable file");
    originalSize = before.size;
    const hash = NodeCrypto.createHash("sha256");
    let offset = 0n;
    let reachedEof = false;
    const buffer = new Uint8Array(chunkSize);

    while (offset < before.size) {
      const remaining = before.size - offset;
      const requested = remaining > BigInt(chunkSize) ? chunkSize : Number(remaining);
      const read = await capture.storage.readInto(
        capture.inode,
        offset,
        buffer.subarray(0, requested),
      );
      if (!Number.isSafeInteger(read) || read < 0 || read > requested) {
        throw new Error("Output storage returned an invalid read length");
      }
      if (read === 0) {
        reachedEof = true;
        break;
      }
      const chunk = buffer.slice(0, read);
      hash.update(chunk);
      failureOperation = "write-output-chunk";
      await options.writeOutputChunk(capture.outputId, chunk);
      failureOperation = "capture-output";
      bytesCaptured += read;
      offset += BigInt(read);
    }

    const after = await capture.storage.stat(capture.inode);
    stable = before.size === after.size && before.mtimeNs === after.mtimeNs;
    const completeRead = !reachedEof && offset === before.size;
    fullHash = stable && completeRead;
    if (fullHash) sha256 = hash.digest("hex");
    outputStatus = fullHash ? "captured" : stable ? "partial" : "unstable";

    const metadata: NodeChildProcessTraceOutputMetadata = {
      outputId: capture.outputId,
      processKey: options.processKey,
      childId: options.childId,
      streams: capture.streams,
      streamLabel: streamLabel(capture.streams),
      mountId: capture.mount.id,
      mountPath: capture.mount.path,
      inode: capture.inode.toString(),
      paths: capture.paths,
      originalSize: before.size.toString(),
      bytesCaptured,
      fullHash,
      stable,
      ...(sha256 === undefined ? {} : { sha256 }),
    };
    failureOperation = "finish-output";
    const result = await options.finishOutput(metadata);
    locator = typeof result === "string" ? result : result.locator;
    if (typeof locator !== "string" || locator.length === 0)
      throw new Error("Output writer did not return a durable locator");
    failureOperation = "capture-output";
  } catch (error) {
    failure = error;
    options.onFailure(failureOperation, capture.outputId, error);
  } finally {
    try {
      await capture.storage.release(capture.inode);
    } catch (error) {
      releaseFailure = error;
      options.onFailure("capture-output", capture.outputId, error);
    }
  }

  const completedWallTimeMs = Date.now();
  const captureDurationMs = Math.max(0, monotonicNow() - startedMonotonicMs);
  const output: OutputResult = {
    outputId: capture.outputId,
    streams: capture.streams,
    streamLabel: streamLabel(capture.streams),
    status: failure === undefined ? outputStatus : "gap",
    reason: failure === undefined ? undefined : "capture-failed",
    processKey: options.processKey,
    childId: options.childId,
    mountId: capture.mount.id,
    mountPath: capture.mount.path,
    inode: capture.inode.toString(),
    paths: capture.paths,
    originalSize: originalSize.toString(),
    bytesCaptured,
    fullHash: failure === undefined && fullHash,
    stable: failure === undefined && stable,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(locator === undefined ? {} : { locator }),
    ...(failure === undefined ? {} : { error: safeError(failure) }),
    ...(releaseFailure === undefined ? {} : { releaseError: safeError(releaseFailure) }),
    captureTiming: {
      startedAtWallTimeMs: startedWallTimeMs,
      completedAtWallTimeMs: completedWallTimeMs,
      durationMs: captureDurationMs,
    },
  };
  options.remember(output);
  options.emit({ ...output, eventKind: "output" });
  return output;
}

export function streamLabel(streams: readonly string[]): "stdout" | "stderr" | "combined" {
  return streams.includes("stdout") && streams.includes("stderr")
    ? "combined"
    : streams.includes("stderr")
      ? "stderr"
      : "stdout";
}

export function safeOutputError(error: unknown): Readonly<Record<string, unknown>> {
  return serializeTraceValue(error);
}

function safeError(error: unknown): Readonly<Record<string, unknown>> {
  return safeOutputError(error);
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
