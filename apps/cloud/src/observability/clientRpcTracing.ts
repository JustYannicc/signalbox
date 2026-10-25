import { WsRpcGroup } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { contentFreeTracer } from "@t3tools/shared/clientTraceSafety";

import * as ClientTraceExport from "./ClientTraceExport.ts";

const TRACE_ID = /^[a-f0-9]{32}$/i;
const SPAN_ID = /^[a-f0-9]{16}$/i;
const SERVER_SPAN_PREFIX = "RpcServer.";

export type RpcSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: ReadonlyArray<{
    readonly key: string;
    readonly value: { readonly stringValue: string };
  }>;
  readonly status: { readonly code: number };
};

export type ClientTraceSubmit = (span: RpcSpan) => void;

type ClientRpcTraceSinkService = { readonly submit: ClientTraceSubmit };

/** Optional telemetry leaves existing and test connections working without an exporter. */
export const ClientRpcTraceSink = Context.Reference<ClientRpcTraceSinkService>(
  "@signalbox/cloud/observability/ClientRpcTraceSink",
  {
    defaultValue: () => ({ submit: () => {} }),
  },
);

/**
 * The Durable Object boundary adapts Effect export to the promise Cloudflare
 * keeps alive. The buffer includes its in-flight batch, so telemetry stays bounded.
 */
const makeRpcTraceSink = (
  exporter: ClientTraceExport.ClientTraceExport["Service"],
  env: Parameters<typeof ClientTraceExport.layer>[0],
  waitUntil: (promise: Promise<unknown>) => void,
) => {
  const pending: Array<RpcSpan> = [];
  let buffered = 0;
  let scheduled = false;
  let running = false;

  const submitBatch = (spans: ReadonlyArray<RpcSpan>) =>
    exporter.submit({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "signalbox-cloud" } },
              {
                key: "deployment.environment",
                value: { stringValue: env.SIGNALBOX_STAGE ?? "development" },
              },
              { key: "service.version", value: { stringValue: env.APP_VERSION ?? "development" } },
            ],
          },
          scopeSpans: [{ scope: { name: "signalbox.cloud.rpc" }, spans }],
        },
      ],
    });

  const schedule = () => {
    if (scheduled || running || pending.length === 0) return;
    scheduled = true;
    const task = Promise.resolve().then(async () => {
      scheduled = false;
      if (running || pending.length === 0) return;
      running = true;
      const batch = pending.splice(0, 128);
      try {
        // Cloudflare owns the promise lifetime; keep Effect execution at this adapter boundary.
        await Effect.runPromise(submitBatch(batch));
      } catch {
        // Export failure must not affect the socket or its RPC result.
      } finally {
        buffered -= batch.length;
        running = false;
        schedule();
      }
    });
    try {
      waitUntil(task);
    } catch {
      // The operation can still settle if the runtime cannot retain it.
    }
  };

  return {
    submit: (span: RpcSpan) => {
      if (buffered >= 128) return;
      pending.push(span);
      buffered += 1;
      schedule();
    },
  } satisfies ClientRpcTraceSinkService;
};

/** Builds the sink beside the UserObject so pending exports survive hibernation. */
export const layer = (
  env: Parameters<typeof ClientTraceExport.layer>[0],
  waitUntil: (promise: Promise<unknown>) => void,
) =>
  Layer.effect(
    ClientRpcTraceSink,
    Effect.map(ClientTraceExport.ClientTraceExport, (exporter) =>
      makeRpcTraceSink(exporter, env, waitUntil),
    ),
  ).pipe(Layer.provideMerge(ClientTraceExport.layer(env)));

const rpcMethodOf = (name: string): string | undefined => {
  const method = name.startsWith(SERVER_SPAN_PREFIX) ? name.slice(SERVER_SPAN_PREFIX.length) : "";
  return WsRpcGroup.requests.has(method) ? method : undefined;
};

const validParent = (parent: Tracer.AnySpan | undefined): parent is Tracer.AnySpan =>
  parent !== undefined &&
  TRACE_ID.test(parent.traceId) &&
  SPAN_ID.test(parent.spanId) &&
  !/^0+$/.test(parent.traceId) &&
  !/^0+$/.test(parent.spanId);

const stringAttribute = (key: string, value: unknown) =>
  typeof value === "string" ? { key, value: { stringValue: value } } : undefined;

/** A one-span OTLP tracer; RPC frames carry the client span identity as parent context. */
export function makeClientRpcTracer(userId: string, submit: ClientTraceSubmit): Tracer.Tracer {
  const delegate = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      span.attribute("person.id", userId);
      const method = rpcMethodOf(options.name);
      if (method !== undefined) span.attribute("rpc.method", method);
      return span;
    },
  });
  const safeDelegate = contentFreeTracer(delegate);

  return Tracer.make({
    span(options) {
      const method = rpcMethodOf(options.name);
      const isRpcServerSpan = method !== undefined && options.kind === "server";
      if (!isRpcServerSpan) return new Tracer.NativeSpan(options);

      const parent = Option.getOrUndefined(options.parent);
      const span = safeDelegate.span({
        ...options,
        kind: "server",
        name: method,
        parent: validParent(parent) ? Option.some(parent) : Option.none(),
        links: [],
      });
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        if (!span.sampled) return;
        const status = span.status;
        if (status._tag !== "Ended") return;
        try {
          submit({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(Option.isSome(span.parent) ? { parentSpanId: span.parent.value.spanId } : {}),
            name: span.name,
            kind: 2,
            startTimeUnixNano: String(status.startTime),
            endTimeUnixNano: String(status.endTime),
            attributes: [...span.attributes].flatMap(([key, value]) => {
              const attribute = stringAttribute(key, value);
              return attribute === undefined ? [] : [attribute];
            }),
            status: { code: status.exit._tag === "Success" ? 1 : 2 },
          });
        } catch {
          // Telemetry must not change the RPC result.
        }
      };
      return span;
    },
  });
}
