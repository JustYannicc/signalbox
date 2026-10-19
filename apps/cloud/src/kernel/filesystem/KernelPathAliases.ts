export function descriptorPathAlias(path: string): number | undefined {
  const named = new Map([
    ["/dev/stdin", 0],
    ["/dev/stdout", 1],
    ["/dev/stderr", 2],
  ]).get(path);
  if (named !== undefined) return named;

  const match = /^\/(?:proc\/self\/fd|dev\/fd)\/(0|[1-9][0-9]*)$/.exec(path);
  if (match === null) return undefined;
  const fd = Number(match[1]);
  return Number.isSafeInteger(fd) ? fd : undefined;
}

export interface DescriptorPathSuffix {
  readonly fd: number;
  readonly relativePath: string;
}

export function descriptorPathSuffix(path: string): DescriptorPathSuffix | undefined {
  const match = /^\/(?:proc\/self\/fd|dev\/fd)\/(0|[1-9][0-9]*)\/([\s\S]*)$/.exec(path);
  if (match === null) return undefined;
  const fd = Number(match[1]);
  if (!Number.isSafeInteger(fd)) return undefined;

  // Extra separators belong to the suffix, not to an absolute mount path.
  const relativePath = (match[2] ?? "").replace(/^\/+/, "");
  return { fd, relativePath: relativePath === "" ? "." : relativePath };
}
