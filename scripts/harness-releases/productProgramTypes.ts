export interface Pin {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly revision?: string;
}

export interface ProductProgramPinSnapshot {
  readonly schemaVersion: 1;
  readonly commandExecutablePaths: readonly string[];
  readonly files: Readonly<Record<string, Pin>>;
  readonly coreutils: { readonly commands: Readonly<Record<string, Pin>> };
  readonly coreutilsProvenance: Pin;
  readonly gitTemplates: {
    readonly source: {
      readonly archiveUrl: string;
      readonly archiveBytes: number;
      readonly archiveSha256: string;
    };
    readonly directories: ReadonlyArray<{ readonly assetPath: string; readonly mode: string }>;
    readonly files: ReadonlyArray<{
      readonly sourceMember: string;
      readonly relativeInstallPath: string;
      readonly assetPath: string;
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly mode: number;
    }>;
  };
  readonly gitBuild: {
    readonly recipeSha256: string;
    readonly image: string;
    readonly inputs: Readonly<Record<string, string>>;
  };
  readonly jqPackage: {
    readonly registryManifestUrl: string;
    readonly packageUrl: string;
    readonly packagePath: string;
    readonly packageBytes: number;
    readonly packageSha256: string;
    readonly packageEntry: string;
    readonly imports: ReadonlyArray<{
      readonly module: string;
      readonly name: string;
      readonly kind: string;
    }>;
    readonly exports: ReadonlyArray<{ readonly name: string; readonly kind: string }>;
  };
}

export interface AssetPin {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly provenance?: AssetPin & { readonly sourceUrl?: string };
}

export interface ProgramManifest {
  readonly schemaVersion: 1;
  readonly programs: Readonly<Record<string, AssetPin>>;
}
