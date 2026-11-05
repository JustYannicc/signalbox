import type { ClaudeSdkAdapterOptions } from "./ClaudeSdkAdapter.ts";

export interface ClaudeSdkRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly redirect: RequestRedirect;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface ClaudeSdkHostPreparation extends Pick<
  ClaudeSdkAdapterOptions,
  "adapter" | "mcpSessions" | "loadSdk" | "onQueryPreCleanupDiagnostic"
> {
  readonly assertCompatibility: () => Promise<void>;
}
