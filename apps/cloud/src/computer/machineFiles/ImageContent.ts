export interface MachineImageContent {
  readonly format: "signalbox-machine-image-content-v1";
  readonly imageDigest: `sha256:${string}`;
  readonly captureSha256: string;
  /** SHA-256 of JSON.stringify(inventory) before imageContent is attached. */
  readonly inventorySha256: string;
  readonly includeRule: "regular-files-under-/etc";
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly entries: readonly {
    readonly path: string;
    readonly size: string;
    readonly sha256: string;
    readonly bytesBase64: string;
  }[];
}
