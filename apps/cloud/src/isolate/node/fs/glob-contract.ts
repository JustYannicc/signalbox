export interface NodeGlobCoreDependencies {
  readonly require: (id: string) => unknown;
  readonly primordials: Record<string, unknown>;
  readonly platform: string;
}

export interface NodeGlobCoreModule {
  readonly Glob: new (
    pattern: string | readonly string[],
    options?: unknown,
  ) => {
    glob(): AsyncGenerator<unknown, void, unknown>;
  };
}

export interface NodeGlobMatcherModule {
  readonly GLOBSTAR: unknown;
  readonly Minimatch: new (pattern: string, options?: Record<string, unknown>) => unknown;
  readonly minimatch: (path: string, pattern: string, options?: Record<string, unknown>) => boolean;
}
