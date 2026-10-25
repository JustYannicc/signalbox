export interface BytePattern {
  readonly bytes: Uint8Array;
  readonly binding: number;
}

export interface ByteMatch {
  readonly start: number;
  readonly end: number;
  readonly binding: number;
}

export type ByteRangeReader = (offset: bigint, target: Uint8Array) => number;
export const BYTE_MATCHER_SCAN_CHUNK_BYTES = 64 * 1024;

interface BuildNode {
  readonly edges: Map<number, number>;
  fail: number;
  outputLink: number;
  terminal: number;
}

const BUILD_NODE_BYTES = 128;
const BUILD_EDGE_BYTES = 48;

/** A compact byte Aho-Corasick matcher; secret values and offsets stay in UTF-8 bytes. */
export class ByteMatcher {
  readonly byteSize: number;
  readonly patternCount: number;
  readonly #firstEdge: Int32Array;
  readonly #edgeByte: Uint8Array;
  readonly #edgeTarget: Int32Array;
  readonly #edgeNext: Int32Array;
  readonly #failure: Int32Array;
  readonly #outputLink: Int32Array;
  readonly #terminal: Int32Array;
  readonly #patternLength: Uint32Array;
  readonly #patternBinding: Uint32Array;

  private constructor(nodes: ReadonlyArray<BuildNode>, patterns: ReadonlyArray<BytePattern>) {
    this.patternCount = patterns.length;
    this.#firstEdge = new Int32Array(nodes.length).fill(-1);
    this.#failure = Int32Array.from(nodes, (node) => node.fail);
    this.#outputLink = Int32Array.from(nodes, (node) => node.outputLink);
    this.#terminal = Int32Array.from(nodes, (node) => node.terminal);
    this.#patternLength = Uint32Array.from(patterns, (pattern) => pattern.bytes.byteLength);
    this.#patternBinding = Uint32Array.from(patterns, (pattern) => pattern.binding);

    let edgeCount = 0;
    for (const node of nodes) edgeCount += node.edges.size;
    this.#edgeByte = new Uint8Array(edgeCount);
    this.#edgeTarget = new Int32Array(edgeCount);
    this.#edgeNext = new Int32Array(edgeCount);
    let at = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      for (const [byte, target] of nodes[index]!.edges) {
        this.#edgeByte[at] = byte;
        this.#edgeTarget[at] = target;
        this.#edgeNext[at] = this.#firstEdge[index]!;
        this.#firstEdge[index] = at;
        at += 1;
      }
    }
    this.byteSize =
      this.#firstEdge.byteLength +
      this.#edgeByte.byteLength +
      this.#edgeTarget.byteLength +
      this.#edgeNext.byteLength +
      this.#failure.byteLength +
      this.#outputLink.byteLength +
      this.#terminal.byteLength +
      this.#patternLength.byteLength +
      this.#patternBinding.byteLength;
  }

  static create(patterns: ReadonlyArray<BytePattern>, maxBytes: number): ByteMatcher {
    const nodes: Array<BuildNode> = [{ edges: new Map(), fail: 0, outputLink: -1, terminal: -1 }];
    assertBuildFits(nodes.length, 0, patterns.length, maxBytes);
    for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
      const pattern = patterns[patternIndex]!;
      if (pattern.bytes.byteLength === 0) continue;
      let nodeIndex = 0;
      for (const byte of pattern.bytes) {
        let child = nodes[nodeIndex]!.edges.get(byte);
        if (child === undefined) {
          assertBuildFits(nodes.length + 1, nodes.length, patterns.length, maxBytes);
          child = nodes.length;
          nodes[nodeIndex]!.edges.set(byte, child);
          nodes.push({ edges: new Map(), fail: 0, outputLink: -1, terminal: -1 });
        }
        nodeIndex = child;
      }
      if (nodes[nodeIndex]!.terminal !== -1) throw byteMatcherError("EINVAL");
      nodes[nodeIndex]!.terminal = patternIndex;
    }

    const queue: Array<number> = [];
    for (const child of nodes[0]!.edges.values()) {
      nodes[child]!.fail = 0;
      nodes[child]!.outputLink = -1;
      queue.push(child);
    }
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]!;
      for (const [byte, child] of nodes[current]!.edges) {
        let fallback = nodes[current]!.fail;
        let transition = nodes[fallback]!.edges.get(byte);
        while (transition === undefined && fallback !== 0) {
          fallback = nodes[fallback]!.fail;
          transition = nodes[fallback]!.edges.get(byte);
        }
        const failure = transition ?? 0;
        nodes[child]!.fail = failure;
        nodes[child]!.outputLink =
          nodes[failure]!.terminal === -1 ? nodes[failure]!.outputLink : failure;
        queue.push(child);
      }
    }

    if (patterns.some((pattern) => pattern.bytes.byteLength === 0))
      throw byteMatcherError("EINVAL");
    assertBuildFits(nodes.length, nodes.length - 1, patterns.length, maxBytes);
    return new ByteMatcher(nodes, patterns);
  }

  scan(bytes: Uint8Array, onMatch: (match: ByteMatch) => boolean | void): boolean {
    let state = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      state = this.#scanByte(state, bytes[index]!, index, onMatch);
      if (state === -1) return false;
    }
    return true;
  }

  scanReader(
    size: bigint,
    readInto: ByteRangeReader,
    onMatch: (match: ByteMatch) => boolean | void,
    chunkBytes = BYTE_MATCHER_SCAN_CHUNK_BYTES,
  ): boolean {
    const chunk = new Uint8Array(chunkBytes);
    let offset = 0n;
    let state = 0;
    while (offset < size) {
      const requested = Number(
        size - offset > BigInt(chunk.byteLength) ? BigInt(chunk.byteLength) : size - offset,
      );
      const target = chunk.subarray(0, requested);
      const count = readInto(offset, target);
      if (count !== requested) throw byteMatcherError("EIO");
      for (let index = 0; index < count; index += 1) {
        state = this.#scanByte(state, chunk[index]!, Number(offset) + index, onMatch);
        if (state === -1) return false;
      }
      offset += BigInt(count);
    }
    return true;
  }

  #scanByte(
    current: number,
    byte: number,
    index: number,
    onMatch: (match: ByteMatch) => boolean | void,
  ): number {
    let state = current;
    let edge = this.#edgeFor(state, byte);
    while (edge === -1 && state !== 0) {
      state = this.#failure[state]!;
      edge = this.#edgeFor(state, byte);
    }
    state = edge === -1 ? 0 : this.#edgeTarget[edge]!;
    let output = state;
    while (output !== -1) {
      const pattern = this.#terminal[output]!;
      if (pattern !== -1) {
        const end = index + 1;
        const keepGoing = onMatch({
          start: end - this.#patternLength[pattern]!,
          end,
          binding: this.#patternBinding[pattern]!,
        });
        if (keepGoing === false) return -1;
      }
      output = this.#outputLink[output]!;
    }
    return state;
  }

  #edgeFor(node: number, byte: number): number {
    for (let edge = this.#firstEdge[node]!; edge !== -1; edge = this.#edgeNext[edge]!) {
      if (this.#edgeByte[edge] === byte) return edge;
    }
    return -1;
  }
}

function assertBuildFits(
  nodeCount: number,
  edgeCount: number,
  patternCount: number,
  maxBytes: number,
): void {
  // Include the final typed arrays while trie Maps, node rows, and the BFS queue are live.
  const typedArrays = nodeCount * 16 + edgeCount * 9 + patternCount * 8;
  const buildRows = nodeCount * BUILD_NODE_BYTES + edgeCount * BUILD_EDGE_BYTES;
  if (typedArrays + buildRows > maxBytes) throw byteMatcherError("ENOMEM");
}

function byteMatcherError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
