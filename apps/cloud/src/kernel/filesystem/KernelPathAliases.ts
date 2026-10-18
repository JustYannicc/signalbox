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
