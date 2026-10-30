import type * as NodePath from "node:path";
import { markNodeBuiltinCapability } from "../../NodeBuiltinCapabilities.ts";

/** Own wrappers keep declarations off shared native functions and other runtime profiles. */
export function declaredPathFunctions(native: typeof NodePath.posix, flavor: "posix" | "win32") {
  const methods = {
    basename: (path: string, suffix?: string) => native.basename(path, suffix),
    dirname: (path: string) => native.dirname(path),
    extname: (path: string) => native.extname(path),
    isAbsolute: (path: string) => native.isAbsolute(path),
    join: (...paths: string[]) => native.join(...paths),
    normalize: (path: string) => native.normalize(path),
    parse: (path: string) => native.parse(path),
  };
  for (const name of Object.keys(methods) as (keyof typeof methods)[]) {
    markNodeBuiltinCapability(methods[name], {
      status: "supported",
      evidence: `NodePath.${flavor}.${name} delegates only string processing to native node:path; it does not read the host filesystem or cwd.`,
    });
  }
  return methods;
}
