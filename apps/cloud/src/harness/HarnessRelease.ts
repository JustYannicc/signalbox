export interface HarnessRelease {
  readonly harness: "claude-code" | "codex";
  readonly version: string;
  readonly manifestSha256: string;
  readonly modules: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
}
