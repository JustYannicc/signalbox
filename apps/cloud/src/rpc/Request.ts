export interface RpcRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: ReadableStream<Uint8Array> | null;
  readonly redirect: RequestRedirect;
}

/** The body streams over RPC; cancellation travels on the owner's explicit cancel channel. */
export function rpcRequest(request: Request): RpcRequest {
  return {
    url: request.url,
    method: request.method,
    headers: [...request.headers],
    body: request.body,
    redirect: request.redirect,
  };
}

export function requestFromRpc(input: RpcRequest, signal: AbortSignal) {
  const init = {
    method: input.method,
    headers: input.headers.map<[string, string]>(([name, value]) => [name, value]),
    body: input.body,
    redirect: input.redirect,
    signal,
    duplex: "half",
  };
  return new Request(input.url, init);
}
