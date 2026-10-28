export function childProgramName(executable: string) {
  return executable.slice(executable.lastIndexOf("/") + 1);
}

type ProgramName<Path extends string> = Path extends `${string}/${infer Name}`
  ? ProgramName<Name>
  : Path;

export function childProgramPaths<const Path extends string>(executable: Path) {
  const name = childProgramName(executable) as ProgramName<Path>;
  return [name, `/bin/${name}`, `/usr/bin/${name}`] as const;
}

export function standardChildProgramName(executable: string) {
  const name = childProgramName(executable);
  return childProgramPaths(name).includes(executable) ? name : undefined;
}
