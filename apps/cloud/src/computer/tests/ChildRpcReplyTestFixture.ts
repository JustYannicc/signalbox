export interface ChildImportBinding {
  readonly imports: WebAssembly.Imports;
  bind(instance: WebAssembly.Instance): void;
}

export interface ChildWasmGuest {
  readonly instance: WebAssembly.Instance;
  readonly memory: WebAssembly.Memory;
  readonly run: (...args: number[]) => Promise<number>;
}

export function importReactor(namespace: string, name: string, argumentCount: number) {
  const bytes = (value: string) => {
    const encoded = new TextEncoder().encode(value);
    return [...unsignedLeb128(encoded.byteLength), ...encoded];
  };
  const section = (id: number, content: number[]) => [
    id,
    ...unsignedLeb128(content.length),
    ...content,
  ];
  const body = [
    0,
    ...Array.from({ length: argumentCount }, (_, index) => [32, index]).flat(),
    16,
    0,
    11,
  ];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, 96, argumentCount, ...Array<number>(argumentCount).fill(127), 1, 127]),
      ...section(2, [1, ...bytes(namespace), ...bytes(name), 0, 0]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...bytes("memory"), 2, 0, ...bytes("run"), 0, 1]),
      ...section(10, [1, ...unsignedLeb128(body.length), ...body]),
    ]),
  );
}

export function instantiateImports(
  module: WebAssembly.Module,
  binding: ChildImportBinding,
): ChildWasmGuest {
  const instance = new WebAssembly.Instance(module, binding.imports);
  binding.bind(instance);
  const wasm = WebAssembly as unknown as {
    promising(fn: (...args: number[]) => number): (...args: number[]) => Promise<number>;
  };
  return {
    instance,
    memory: instance.exports.memory as WebAssembly.Memory,
    run: wasm.promising(instance.exports.run as (...args: number[]) => number),
  };
}

export function disposable<T extends object>(reply: T) {
  let count = 0;
  let receiverWasReply = false;
  Object.defineProperty(reply, Symbol.dispose, {
    configurable: true,
    value(this: unknown) {
      count++;
      receiverWasReply = this === reply;
    },
  });
  return {
    reply,
    count: () => count,
    receiverWasReply: () => receiverWasReply,
  };
}

function unsignedLeb128(value: number): number[] {
  const result: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    result.push(value === 0 ? byte : byte | 128);
  } while (value !== 0);
  return result;
}
