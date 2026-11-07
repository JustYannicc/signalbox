declare module "pako/lib/zlib/zstream.js" {
  type Scalars = import("./inflateState.ts").InflateScalars;
  type ArrayField = import("./inflateState.ts").ArrayField;
  export type PakoArray = Uint8Array | Uint16Array | Int32Array;
  export type PakoState = { -readonly [K in keyof Scalars]: number } & {
    [K in ArrayField]: PakoArray | null;
  } & { strm: ZStream; head: null; next: null };
  export default class ZStream {
    input: Uint8Array | null;
    next_in: number;
    avail_in: number;
    total_in: number;
    output: Uint8Array | null;
    next_out: number;
    avail_out: number;
    total_out: number;
    msg: string;
    state: PakoState | null;
    data_type: number;
    adler: number;
  }
}
declare module "pako/lib/zlib/inflate.js" {
  import type ZStream from "pako/lib/zlib/zstream.js";
  const inflate: {
    inflateInit2(stream: ZStream, windowBits: number): number;
    inflate(stream: ZStream, flush: number): number;
  };
  export default inflate;
}
