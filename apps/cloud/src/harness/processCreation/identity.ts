export const NATIVE_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const creationInvocationKey = (runId: string) =>
  `harness-process-creation-invocation/v1/${encodeURIComponent(runId)}`;
