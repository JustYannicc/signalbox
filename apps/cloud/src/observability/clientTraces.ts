import { clientSpanAttribute, clientSpanName } from "@t3tools/shared/clientTraceSafety";
import type { ClientTraceDimension } from "../user/UserDirectory.ts";
import * as Schema from "effect/Schema";

const hex = (length: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[a-f0-9]{${length}}$`, "i")));
const nanos = Schema.String.check(Schema.isPattern(/^\d{1,20}$/));
const Attribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    stringValue: Schema.optional(Schema.String),
    intValue: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    boolValue: Schema.optional(Schema.Boolean),
  }),
});
const Span = Schema.Struct({
  traceId: hex(32),
  spanId: hex(16),
  parentSpanId: Schema.optional(hex(16)),
  name: Schema.String,
  kind: Schema.optional(Schema.Number),
  startTimeUnixNano: nanos,
  endTimeUnixNano: nanos,
  attributes: Schema.optional(Schema.Array(Attribute)),
  status: Schema.optional(Schema.Struct({ code: Schema.Number })),
});
export const ClientTraces = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Schema.optional(
        Schema.Struct({ attributes: Schema.optional(Schema.Array(Attribute)) }),
      ),
      scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(Span) })),
    }),
  ),
});

/** Rebuild the OTLP document. Unknown fields, exception events and arbitrary strings never leave intake. */
export function safeClientTraces(
  input: typeof ClientTraces.Type,
  personId: string,
  environment: string,
  release: string,
  dimensions: ReadonlyArray<ClientTraceDimension> = [],
) {
  const spans = input.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
  if (
    spans.length > 256 ||
    spans.some(
      (span) =>
        /^0+$/.test(span.traceId) ||
        /^0+$/.test(span.spanId) ||
        BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano),
    )
  )
    return null;
  const byThread = new Map(dimensions.map((dimension) => [dimension.threadId, dimension]));
  const attribute = (key: string, stringValue: string) => ({ key, value: { stringValue } });
  const safeAttributes = (attributes: typeof Span.Type.attributes) =>
    (attributes ?? []).flatMap((item) => {
      const value =
        item.value.stringValue ??
        item.value.boolValue ??
        (item.value.intValue === undefined ? undefined : Number(item.value.intValue));
      if (
        ["person.id", "org.id", "folder.id", "thread.id", "automation.id"].includes(item.key) ||
        !clientSpanAttribute(item.key, value)
      )
        return [];
      // Reconstruct the value too: an attacker can send several AnyValue variants at once.
      return [
        {
          key: item.key,
          value:
            typeof value === "string"
              ? { stringValue: value }
              : typeof value === "boolean"
                ? { boolValue: value }
                : { intValue: String(value) },
        },
      ];
    });
  return {
    resourceSpans: input.resourceSpans.map((resource) => {
      const mode =
        resource.resource?.attributes?.find(
          (item) =>
            ["service.mode", "service.runtime"].includes(item.key) &&
            ["browser", "electron", "react-native"].includes(item.value.stringValue ?? ""),
        )?.value.stringValue ?? "browser";
      return {
        resource: {
          attributes: [
            attribute("service.name", mode === "react-native" ? "t3code-mobile" : "t3code-web"),
            attribute("service.mode", mode),
            attribute("deployment.environment", environment),
            attribute("service.version", release),
          ],
        },
        scopeSpans: resource.scopeSpans.map((scope) => ({
          scope: { name: "signalbox.client" },
          spans: scope.spans.map((span) => {
            const dimension = byThread.get(
              span.attributes?.find((item) => item.key === "thread.id")?.value.stringValue ?? "",
            );
            return {
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: clientSpanName(span.name),
              kind: [0, 1, 2, 3, 4, 5].includes(span.kind ?? 0) ? (span.kind ?? 0) : 0,
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              attributes: [
                attribute("person.id", personId),
                ...safeAttributes(span.attributes),
                ...(dimension
                  ? [
                      attribute("thread.id", dimension.threadId),
                      ...(dimension.folderId ? [attribute("folder.id", dimension.folderId)] : []),
                      ...(dimension.orgId ? [attribute("org.id", dimension.orgId)] : []),
                    ]
                  : []),
              ],
              status: {
                code: [0, 1, 2].includes(span.status?.code ?? 0) ? (span.status?.code ?? 0) : 0,
              },
            };
          }),
        })),
      };
    }),
  };
}
