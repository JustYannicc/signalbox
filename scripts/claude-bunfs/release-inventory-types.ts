export interface ScannableModule {
  readonly index: number;
  readonly key: string;
  readonly name: string;
  readonly loader: number;
  readonly format?: number;
  readonly bytes: number;
  readonly source?: string;
}

export interface SourceLocation {
  readonly module: string;
  readonly key: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export type BuiltinImportKind = "named" | "default" | "namespace" | "side-effect" | "require";

export interface BuiltinImport extends SourceLocation {
  readonly kind: BuiltinImportKind;
  readonly imported: string;
  readonly local: string | null;
}

export interface BuiltinMemberUse extends SourceLocation {
  readonly member: string;
  readonly access: "read" | "call" | "construct";
  readonly via: "namespace" | "default" | "require";
  readonly guarded: boolean;
}

export interface BuiltinDynamicMember extends SourceLocation {
  readonly via: "namespace" | "default" | "require";
  readonly guarded: boolean;
}

export interface BuiltinUse {
  readonly specifier: string;
  readonly canonicalBuiltin: string;
  readonly module: string;
  readonly key: string;
  readonly imports: ReadonlyArray<BuiltinImport>;
  readonly memberUses: ReadonlyArray<BuiltinMemberUse>;
  readonly dynamicMemberUses: ReadonlyArray<BuiltinDynamicMember>;
}
