import type { NodeFsModules } from "../../src/isolate/NodeFs.ts";
import type { StandardProofAdapter } from "./standardProofAdapter.ts";

const placeholders = /\{\{(?:secret:|op:\/\/)/;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Only whole UTF-8 workspace writes are covered by this test adapter. */
export function installStandardProofFiles(fs: NodeFsModules, gateway: StandardProofAdapter) {
  const promises = fs["fs/promises"];
  const open = promises.open.bind(promises);
  const writeFile = promises.writeFile.bind(promises);

  const fill = async (
    path: unknown,
    data: Parameters<typeof writeFile>[1],
    operation: (data: Parameters<typeof writeFile>[1]) => Promise<void>,
  ) => {
    if (typeof path !== "string" || !path.startsWith("/work/")) return operation(data);
    let text: string;
    try {
      text = typeof data === "string" ? data : decoder.decode(data);
    } catch {
      return operation(data);
    }
    if (!placeholders.test(text)) return operation(data);
    await gateway.write(text, (filled) => operation(filled));
  };

  promises.open = async (...args) => {
    const handle = await open(...args);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = (data, options) =>
      fill(handle.path, data, (filled) => write(filled, options));
    return handle;
  };
  promises.writeFile = (path, data, options) =>
    fill(path, data, (filled) => writeFile(path, filled, options));

  return () => {
    promises.open = open;
    promises.writeFile = writeFile;
  };
}
