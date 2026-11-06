export const synchronousSpawnErrors = new WeakMap<object, Error>();
export function getSynchronousSpawnError(child: object): Error | undefined {
  return synchronousSpawnErrors.get(child);
}
