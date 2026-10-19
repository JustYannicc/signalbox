export interface NodeGeneratedCodeResponseHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: [string, string][];
  readonly hasBody: boolean;
}

export interface NodeGeneratedCodeInvocation {
  run(): Promise<NodeGeneratedCodeResponseHead>;
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  /** Resolves only after the child fetch settles and its body cancellation finishes. */
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}

export interface NodeGeneratedCodeOpenPort {
  open(envelope: string): Promise<NodeGeneratedCodeInvocation>;
}
