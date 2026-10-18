declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.bin" {
  const bytes: ArrayBuffer | Uint8Array;
  export default bytes;
}
declare module "*.txt" {
  const source: string;
  export default source;
}
