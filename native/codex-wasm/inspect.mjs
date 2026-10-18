import * as NodeFSP from "node:fs/promises";

const module = await WebAssembly.compile(await NodeFSP.readFile(process.argv[2]));
process.stdout.write(
  JSON.stringify({
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  }),
);
