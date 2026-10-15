/** `.wasm` imports are CompiledWasm modules in workerd (wrangler's and Alchemy's bundlers). */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
