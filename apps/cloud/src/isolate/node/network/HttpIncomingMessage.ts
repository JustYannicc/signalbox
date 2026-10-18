// @effect-diagnostics nodeBuiltinImport:off - Responses expose the host Node IncomingMessage and its stream behavior.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

interface ResponseHeaders {
  readonly raw: string[];
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly distinct: Record<string, string[]>;
}

function responseHeaders(response: Response): ResponseHeaders {
  const raw: string[] = [];
  const distinct = Object.create(null) as Record<string, string[]>;
  const getSetCookie = Reflect.get(response.headers, "getSetCookie");
  const setCookies =
    typeof getSetCookie === "function"
      ? (Reflect.apply(getSetCookie, response.headers, []) as string[])
      : undefined;
  const append = (name: string, value: string) => {
    const lowerName = name.toLowerCase();
    raw.push(name, value);
    (distinct[lowerName] ??= []).push(value);
  };

  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie" && setCookies !== undefined) return;
    append(name, value);
  });
  for (const cookie of setCookies ?? []) append("set-cookie", cookie);

  const headers = Object.create(null) as NodeHttp.IncomingHttpHeaders;
  for (const [name, values] of Object.entries(distinct)) {
    headers[name] =
      name === "set-cookie" ? values : name === "cookie" ? values.join("; ") : values.join(", ");
  }
  return { raw, headers, distinct };
}

export class LocalIncomingMessage extends NodeHttp.IncomingMessage {
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #reading = false;
  #onReadActivity: (() => void) | undefined;

  constructor(response: Response, method: string, path: string, onReadActivity?: () => void) {
    super(undefined as unknown as NodeNet.Socket);
    this.statusCode = response.status;
    this.statusMessage = response.statusText;
    this.url = path;
    this.method = method;
    const { raw, headers, distinct } = responseHeaders(response);
    this.rawHeaders = raw;
    this.headers = headers;
    Reflect.set(this, "headersDistinct", distinct);
    this.#reader = response.body?.getReader();
    this.#onReadActivity = onReadActivity;
  }

  override _read(): void {
    if (this.#reading) return;
    if (!this.#reader) {
      this.complete = true;
      this.push(null);
      return;
    }
    this.#reading = true;
    void this.#pump();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.#reader || this.complete) {
      super._destroy(error, callback);
      return;
    }
    void this.#reader.cancel(error).then(
      () => super._destroy(error, callback),
      () => super._destroy(error, callback),
    );
  }

  async #pump(): Promise<void> {
    try {
      while (this.#reader && !this.destroyed) {
        const next = await this.#reader.read();
        if (this.destroyed) return;
        if (next.done) {
          this.complete = true;
          this.push(null);
          return;
        }
        this.#onReadActivity?.();
        if (!this.push(next.value)) return;
      }
    } catch (error) {
      if (!this.destroyed) this.destroy(error as Error);
    } finally {
      this.#reading = false;
    }
  }
}
