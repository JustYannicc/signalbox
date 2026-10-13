import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";

/**
 * Platform services for code running on Cloudflare: Effect's `Crypto` over
 * WebCrypto, and the HTTP platform pieces `HttpApiBuilder` asks for. The cloud
 * serves no files, so file responses and the filesystem are stubs that refuse.
 */

export const layerCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const layerHttpPlatform = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("The cloud does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("The cloud does not serve file responses"),
});

export const layerHttp = Layer.mergeAll(
  layerHttpPlatform,
  Etag.layerWeak,
  Path.layer,
  FileSystem.layerNoop({}),
);
