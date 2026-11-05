import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import type { createClaudeSdkFiles } from "./files.ts";

export function claudeSdkFileSystem(files: ReturnType<typeof createClaudeSdkFiles>) {
  const access = <A>(method: string, path: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method,
          pathOrDescriptor: path,
          cause,
        }),
    });
  return FileSystem.makeNoop({
    exists: (path) =>
      access("exists", path, async () => {
        try {
          await files.call("access", path);
          return true;
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            Reflect.get(cause, "code") === "ENOENT"
          )
            return false;
          throw cause;
        }
      }),
    readFile: (path) =>
      access("readFile", path, async () => {
        const value = await files.call("readFile", path);
        if (!(value instanceof Uint8Array)) throw new Error("SDK readFile returned no bytes");
        return value;
      }),
    readFileString: (path) =>
      access("readFileString", path, async () =>
        String(await files.call("readFile", path, "utf8")),
      ),
    readDirectory: (path) =>
      access("readDirectory", path, async () => {
        const value = await files.call("readdir", path);
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
          throw new Error("SDK readdir returned invalid names");
        return value as string[];
      }),
    makeDirectory: (path, options) =>
      access("makeDirectory", path, async () => {
        await files.call("mkdir", path, options);
      }),
  });
}
