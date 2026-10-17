import { Context, Effect, Stream } from "effect";
export interface Folder {
  readonly key: string;
  readonly title: string;
  readonly position: number;
}
export interface Thread {
  readonly key: string;
  readonly folder: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly position: number;
}
export class CatalogSync extends Context.Service<
  CatalogSync,
  {
    readonly connection: Stream.Stream<string, Error>;
    readonly sidebar: Stream.Stream<readonly Folder[], Error>;
    readonly threads: (folder: string) => Stream.Stream<readonly Thread[], Error>;
    readonly update: (
      key: string,
      revision: number,
      folder?: string,
    ) => Effect.Effect<number, Error>;
  }
>()("spike/CatalogSync") {}
