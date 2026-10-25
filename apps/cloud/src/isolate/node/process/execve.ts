import { NodeSystemError } from "./NodeError.ts";

function validateExecveArguments(file: unknown, args: unknown, env: unknown): string {
  if (typeof file !== "string") {
    throw new TypeError('The "file" argument must be of type string');
  }
  if (file.includes("\0")) throw new TypeError('The "file" argument must not contain null bytes');
  if (!Array.isArray(args)) {
    throw new TypeError('The "args" argument must be an array');
  }
  for (let index = 0; index < args.length; index++) {
    const argument: unknown = args[index];
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new TypeError(`The "args[${index}]" argument must be a string without null bytes`);
    }
  }
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      throw new TypeError('The "env" argument must be an object');
    }
    for (const [key, value] of Object.entries(env)) {
      if (key.includes("\0") || typeof value !== "string" || value.includes("\0")) {
        throw new TypeError(
          'The "env" argument must contain string keys and values without null bytes',
        );
      }
    }
  }
  return file;
}

/** The kernel has no operation that replaces the current process image. */
export function nodeExecveUnavailable(file: unknown, args: unknown, env: unknown): never {
  const path = validateExecveArguments(file, args, env);
  throw new NodeSystemError(
    "ENOSYS",
    `ENOSYS: function not implemented, execve '${path}'`,
    "execve",
    { path },
  );
}
