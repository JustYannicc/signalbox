import { describe, expect, it, vi } from "vite-plus/test";
import { handleProbe } from "../probeRoutes.ts";

const token = "probe-secret-".repeat(4);
const fixture = () => ({
  status: vi.fn(async () => ({ run: null, worker: null })),
  advance: vi.fn(async (_archive: boolean) => ({ done: true })),
  workerConnect: vi.fn(async () => ({ connected: true as const, durationMs: 12 })),
});
const request = (path: string, method = "POST", authorization = `Bearer ${token}`) =>
  new Request(`https://probe${path}`, { method, headers: { authorization } });

describe("probe HTTP authority", () => {
  it("refuses missing or query credentials before any control call", async () => {
    const control = fixture();
    const response = await handleProbe(
      request(`/archive?token=${token}`, "POST", ""),
      token,
      control,
    );
    expect(response.status).toBe(401);
    expect(control.advance).not.toHaveBeenCalled();
    expect(control.workerConnect).not.toHaveBeenCalled();
  });

  it("accepts only fixed methods and paths and never exposes the session RPC", async () => {
    const control = fixture();
    for (const [path, method] of [
      ["/archive", "GET"],
      ["/session", "POST"],
      ["/machine/delete", "POST"],
    ]) {
      expect((await handleProbe(request(path!, method!), token, control)).status).toBe(404);
    }
    expect(control.advance).not.toHaveBeenCalled();
    expect((await handleProbe(request("/archive"), token, control)).status).toBe(200);
    expect(control.advance).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("never serializes control errors, secrets, or upstream response bodies", async () => {
    const control = fixture();
    control.advance.mockRejectedValue(new Error("api_key=private JWT=raw-upstream"));
    const response = await handleProbe(request("/advance"), token, control);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain("private");
    expect(body).not.toContain("raw-upstream");
  });
});
