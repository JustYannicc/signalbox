// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface WasiPollResult {
  bytes: bigint;
  hangup?: boolean;
}

export interface WasiStdio {
  /** Opts into synchronous I/O or EAGAIN whenever the passed flags include NONBLOCK. */
  readonly supportsNonblocking?: boolean;
  readInto?: (target: Uint8Array, flags: number) => number | Promise<number>;
  write?: (source: Uint8Array, flags: number) => number | Promise<number>;
  sync?: () => void | Promise<void>;
  /** Completes when ready; abort detaches a pending readiness subscription. */
  poll?: (
    direction: "read" | "write",
    signal: AbortSignal,
  ) => WasiPollResult | Promise<WasiPollResult>;
}
