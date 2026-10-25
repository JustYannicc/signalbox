import type { ClientIssue as ClientIssueContract } from "@t3tools/contracts/clientIssues";

import type { OtlpTraces } from "./nativeTracesFilter.ts";

const attribute = (key: string, stringValue: string) => ({ key, value: { stringValue } });

/** Rebuild the client symptom and intake spans from the closed issue contract. */
export const make = (
  issue: ClientIssueContract,
  personId: string,
  serverSpanId: string,
  now: bigint,
  orgId: string | null,
): OtlpTraces => {
  const spanAttributes = [
    attribute("person.id", personId),
    ...(orgId === null ? [] : [attribute("org.id", orgId)]),
    attribute("client.issue.code", issue.code),
    attribute("client.issue.severity", issue.severity),
    attribute("client.issue.source", issue.source),
    attribute("client.type", issue.client),
    attribute("client.release", issue.release),
    ...(issue.environmentId === null ? [] : [attribute("environment.id", issue.environmentId)]),
    ...(issue.threadId === null ? [] : [attribute("thread.id", issue.threadId)]),
    ...(issue.folderId === null ? [] : [attribute("folder.id", issue.folderId)]),
    ...(issue.method === undefined ? [] : [attribute("rpc.method", issue.method)]),
    ...(issue.durationMs === undefined
      ? []
      : [{ key: "client.issue.duration_ms", value: { doubleValue: issue.durationMs } }]),
  ];
  const nanos = now.toString();
  const clientSpan = {
    traceId: issue.traceId,
    spanId: issue.spanId,
    name: "client.issue",
    kind: 3,
    startTimeUnixNano: (now - 1_000_000n).toString(),
    endTimeUnixNano: nanos,
    attributes: spanAttributes,
    status: { code: issue.severity === "error" ? 2 : 0 },
  };
  const serverSpan = {
    traceId: issue.traceId,
    spanId: serverSpanId,
    parentSpanId: issue.spanId,
    name: "client.issue.intake",
    kind: 2,
    startTimeUnixNano: (now - 1_000_000n).toString(),
    endTimeUnixNano: nanos,
    attributes: spanAttributes,
    status: { code: 0 },
  };
  const clientHasExistingSpan = issue.existingSpan === true;

  return {
    resourceSpans: [
      ...(!clientHasExistingSpan
        ? [
            {
              resource: { attributes: [attribute("service.name", `t3code-${issue.client}`)] },
              scopeSpans: [{ scope: { name: "signalbox.client_issue" }, spans: [clientSpan] }],
            },
          ]
        : []),
      {
        resource: { attributes: [attribute("service.name", "signalbox-cloud")] },
        scopeSpans: [{ scope: { name: "signalbox.client_issue" }, spans: [serverSpan] }],
      },
    ],
  };
};
