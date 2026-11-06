import type {
  KernelLowerFileSystem,
  KernelLowerFileSystemEntry,
} from "../../../kernel/KernelLowerFileSystem.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";

const encoder = new TextEncoder();

/**
 * A machine image layer below Computer's own files. Writes change the machine only: the kernel's
 * lower index keeps serving what it cached until the machine profile's exit refresh drops it.
 */
export function lowerLayer(files: Record<string, string>) {
  const bytes = new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
  const entry = (path: string): KernelLowerFileSystemEntry | undefined => {
    const file = bytes.get(path);
    const directory = [...bytes.keys()].some((name) =>
      name.startsWith(path === "/" ? "/" : `${path}/`),
    );
    if (file === undefined && !directory) return undefined;
    return {
      path,
      stat: {
        type: file === undefined ? "directory" : "file",
        size: BigInt(file?.byteLength ?? 0),
        nlink: file === undefined ? 2n : 1n,
        atimeNs: 11n,
        mtimeNs: 12n,
        ctimeNs: 13n,
      },
      metadata: { mode: file === undefined ? 0o755 : 0o644, uid: 1000, gid: 1000 },
    };
  };
  const children = (path: string) => {
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Set(
      [...bytes.keys()].flatMap((name) =>
        name.startsWith(prefix) ? [name.slice(prefix.length).split("/")[0]!] : [],
      ),
    );
    return [...names].map((name) => entry(prefix + name)!);
  };
  let handle: KernelLowerFileSystem | undefined;
  return {
    install(files: KernelFileSystem) {
      handle = files.installLowerFileSystem({
        lookup: (paths) => paths.map(entry),
        readdir: async (path) =>
          entry(path)?.stat.type === "directory" ? children(path) : undefined,
        readlink: async () => {
          throw new Error("No lower symlink");
        },
        read: async (path, offset, length) =>
          bytes.get(path)!.subarray(Number(offset), Number(offset) + length),
      });
    },
    write(path: string, text: string) {
      bytes.set(path, encoder.encode(text));
    },
    refreshAfterCommand() {
      handle!.invalidate();
    },
  };
}
