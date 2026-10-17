import { probeAuthorized, probeReply } from "./probeAccess.ts";

interface ProbeControl {
  readonly status: () => Promise<unknown>;
  readonly advance: (archive: boolean) => Promise<unknown>;
  readonly workerConnect: () => Promise<{ connected: true; durationMs: number }>;
}

export async function handleProbe(request: Request, token: string, control: ProbeControl) {
  if (!(await probeAuthorized(request, token))) return probeReply({ error: "Unauthorized" }, 401);
  const { pathname } = new URL(request.url);
  try {
    if (request.method === "GET" && pathname === "/status")
      return probeReply(await control.status());
    if (request.method === "POST" && pathname === "/advance")
      return probeReply(await control.advance(false));
    if (request.method === "POST" && pathname === "/archive")
      return probeReply(await control.advance(true));
    if (request.method === "POST" && pathname === "/worker-connect")
      return probeReply(await control.workerConnect());
    return probeReply({ error: "Not found" }, 404);
  } catch {
    return probeReply(
      { error: "Probe unavailable. Inspect status and retry after one minute." },
      503,
    );
  }
}
