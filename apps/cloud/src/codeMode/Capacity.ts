export interface CodeModeCellPermit {
  release(): Promise<void>;
}

export interface CodeModeCellCapacity {
  acquire(signal: AbortSignal, requester: undefined): Promise<CodeModeCellPermit>;
}
