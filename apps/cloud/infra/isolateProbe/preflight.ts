export function preflightWrapper(
  moduleNames: readonly string[],
  mainModule: string,
  fixtureEntrypoint: string,
) {
  let moduleName = "__signalbox_probe_preflight__.js";
  const names = new Set([...moduleNames, mainModule]);
  while (names.has(moduleName)) moduleName = `_${moduleName}`;
  // Only host aliases are exported, so a fixture cannot shadow the preflight entrypoint.
  const entrypoint = "SignalboxTransportPreflight";
  const fixtureExport = "SignalboxTransportFixture";
  const identity = JSON.stringify([mainModule, fixtureEntrypoint]);
  const specifier = mainModule.startsWith("/") ? mainModule : `./${mainModule}`;
  const source = `import { WorkerEntrypoint } from "cloudflare:workers";
export { ${JSON.stringify(fixtureEntrypoint)} as ${fixtureExport} } from ${JSON.stringify(specifier)};
export class ${entrypoint} extends WorkerEntrypoint {
  fetch(request) { return new Response(request.body, {
    headers: { "x-signalbox-probe-fixture": ${JSON.stringify(identity)} }
  }); }
}`;
  return { moduleName, entrypoint, fixtureExport, identity, source };
}

export async function withPreflight<T>(
  fetchPreflight: (request: Request) => Promise<Response>,
  validate: () => Promise<void>,
  invoke: () => Promise<T>,
  identity?: string,
): Promise<T> {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  // Native passthrough keeps real request I/O alive; an unrooted JS response can be terminated.
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new Uint8Array([1]));
    },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped: Promise<never> | undefined;
  try {
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    const response = await fetchPreflight(new Request("https://probe.invalid/preflight", init));
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error("WorkerLoader preflight did not provide a stream");
    }
    reader = response.body.getReader();
    const ready = await reader.read();
    if (ready.done || ready.value.byteLength !== 1 || ready.value[0] !== 1) {
      throw new Error("WorkerLoader preflight did not provide readiness");
    }
    // Holding only a stub permits eviction. An active response spans validation and fixture use.
    let stoppedError: Error | undefined;
    stopped = reader.read().then(
      () => {
        stoppedError = new Error("WorkerLoader preflight ended before the fixture completed");
        throw stoppedError;
      },
      (cause: unknown) => {
        stoppedError = new Error(`WorkerLoader preflight stream failed: ${String(cause)}`, {
          cause,
        });
        throw stoppedError;
      },
    );
    if (identity !== undefined && response.headers.get("x-signalbox-probe-fixture") !== identity) {
      throw new Error("Cached probe fixture configuration changed; use a fresh id");
    }
    return await Promise.race([
      stopped,
      (async () => {
        await validate();
        if (stoppedError) throw stoppedError;
        return invoke();
      })(),
    ]);
  } finally {
    try {
      controller?.close();
    } catch {
      // The runtime may already have cancelled the host-owned preflight upload.
    }
    try {
      if (stopped) await stopped.catch(() => {});
      else await reader?.cancel();
    } catch {
      // Internal response cleanup must not replace a validation or fixture failure.
    } finally {
      reader?.releaseLock();
    }
  }
}
