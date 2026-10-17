import { MIN_BINARY_SECRET_BYTES } from "@signalbox/runner-protocol/SecretProtection";
import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";

interface Pattern {
  readonly length: number;
  readonly names: ReadonlyArray<string>;
}

interface Node {
  readonly next: Map<number, number>;
  failure: number;
  bestMatch: Pattern | null;
}

const utf8 = new TextEncoder();

const enqueuePrefix = (
  controller: TransformStreamDefaultController<Uint8Array>,
  chunks: ReadonlyArray<Uint8Array>,
  length: number,
) => {
  let remaining = length;
  const rest: Array<Uint8Array> = [];
  for (const chunk of chunks) {
    if (remaining === 0) {
      rest.push(chunk);
    } else if (chunk.length <= remaining) {
      if (chunk.length > 0) controller.enqueue(chunk);
      remaining -= chunk.length;
    } else {
      controller.enqueue(chunk.subarray(0, remaining));
      rest.push(chunk.subarray(remaining));
      remaining = 0;
    }
  }
  return rest;
};

const buildMachine = (secrets: Iterable<SecretValue>) => {
  const patterns = new Map<string, { readonly bytes: Uint8Array; readonly names: Set<string> }>();
  for (const { name, value } of secrets) {
    const bytes = utf8.encode(value);
    if (bytes.byteLength < MIN_BINARY_SECRET_BYTES) continue;
    const pattern = patterns.get(value) ?? { bytes, names: new Set<string>() };
    pattern.names.add(name);
    patterns.set(value, pattern);
  }

  const nodes: Array<Node> = [{ next: new Map(), failure: 0, bestMatch: null }];
  let maxPatternBytes = 0;
  for (const { bytes, names } of patterns.values()) {
    maxPatternBytes = Math.max(maxPatternBytes, bytes.length);
    let at = 0;
    for (const byte of bytes) {
      let next = nodes[at]!.next.get(byte);
      if (next === undefined) {
        next = nodes.length;
        nodes[at]!.next.set(byte, next);
        nodes.push({ next: new Map(), failure: 0, bestMatch: null });
      }
      at = next;
    }
    nodes[at]!.bestMatch = { length: bytes.length, names: [...names] };
  }

  const queue: Array<number> = [];
  for (const child of nodes[0]!.next.values()) queue.push(child);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parent = queue[cursor]!;
    for (const [byte, child] of nodes[parent]!.next) {
      queue.push(child);
      let failure = nodes[parent]!.failure;
      while (failure !== 0 && !nodes[failure]!.next.has(byte)) {
        failure = nodes[failure]!.failure;
      }
      nodes[child]!.failure = nodes[failure]!.next.get(byte) ?? 0;
      const inherited = nodes[nodes[child]!.failure]!.bestMatch;
      const local = nodes[child]!.bestMatch;
      if (local === null || (inherited !== null && inherited.length > local.length)) {
        nodes[child]!.bestMatch = inherited;
      }
    }
  }

  return { nodes, maxPatternBytes };
};

/**
 * Scan arbitrary response bytes without decoding or changing them. The longest
 * possible secret stays buffered, so a match across chunks fails before any
 * byte belonging to it reaches the response reader.
 */
export function scanSecretBytes(
  secrets: Iterable<SecretValue>,
): TransformStream<Uint8Array, Uint8Array> {
  const { nodes, maxPatternBytes } = buildMachine(secrets);
  if (maxPatternBytes === 0) return new TransformStream<Uint8Array, Uint8Array>();

  let pending: Array<Uint8Array> = [];
  let pendingLength = 0;
  let state = 0;
  let totalBytes = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index]!;
        while (state !== 0 && !nodes[state]!.next.has(byte)) {
          state = nodes[state]!.failure;
        }
        state = nodes[state]!.next.get(byte) ?? 0;

        const match = nodes[state]!.bestMatch;
        if (match === null) continue;

        const end = totalBytes + index + 1;
        const firstStart = end - match.length;
        const matchOffset = firstStart - (totalBytes - pendingLength);
        enqueuePrefix(controller, pending, Math.min(matchOffset, pendingLength));
        const chunkPart = matchOffset - pendingLength;
        if (chunkPart > 0) controller.enqueue(chunk.subarray(0, chunkPart));
        const matchedNames = [...match.names].toSorted();
        throw new Error(
          `Signalbox refused a response containing registered secret${matchedNames.length === 1 ? "" : "s"}: ${matchedNames.join(", ")}.`,
        );
      }

      const totalPendingLength = pendingLength + chunk.length;
      const releaseLength = Math.max(0, totalPendingLength - (maxPatternBytes - 1));
      pending = enqueuePrefix(controller, [...pending, chunk], releaseLength);
      pendingLength = totalPendingLength - releaseLength;
      totalBytes += chunk.length;
    },
    flush(controller) {
      for (const chunk of pending) controller.enqueue(chunk);
    },
  });
}
