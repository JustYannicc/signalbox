import {
  PREVIEW_TUNNEL_VERSION,
  type TunnelRunnerMessage,
  tunnelRunnerFrame,
} from "@signalbox/runner-protocol/PreviewTunnel";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { PreviewGateway } from "./PreviewGateway.ts";
import { previewSettings } from "./previewHost.ts";

const threadId = ThreadId.make("thread-preview");
const service = { port: 5173, command: "pnpm dev --host 0.0.0.0", cwd: "." };

const socket = () => {
  let attachment: unknown = null;
  const sent: Array<string | Uint8Array> = [];
  return {
    readyState: Number(WebSocket.OPEN),
    sent,
    serializeAttachment: (value: unknown) => {
      attachment = structuredClone(value);
    },
    deserializeAttachment: () => structuredClone(attachment),
    send: (value: string | Uint8Array) => {
      sent.push(value);
    },
    close() {
      this.readyState = WebSocket.CLOSED;
    },
  };
};
type Socket = ReturnType<typeof socket>;

// Node's Response refuses 101. Only this Cloudflare boundary is substituted.
const NativeResponse = Response;
class SocketResponse extends NativeResponse {
  override readonly webSocket: WebSocket | null;
  private readonly switching: boolean;
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket }) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    this.switching = init?.status === 101;
    this.webSocket = init?.webSocket ?? null;
  }
  override get status() {
    return this.switching ? 101 : super.status;
  }
}
afterEach(() => vi.unstubAllGlobals());

const fixture = () => {
  let now = 1_000;
  let generation = 1;
  let member = true;
  const sockets = new Map<Socket, ReadonlyArray<string>>();
  let configuration: { key: string; services: ReadonlyArray<typeof service> } = {
    key: "thread-signing-key-independent-of-machine",
    services: [service],
  };
  const ctx = {
    getWebSockets: (tag: string) =>
      [...sockets].filter(([, tags]) => tags.includes(tag)).map(([ws]) => ws),
    getTags: (ws: Socket) => sockets.get(ws) ?? [],
    acceptWebSocket: (ws: Socket, tags: ReadonlyArray<string>) => {
      sockets.set(ws, tags);
    },
  } as unknown as DurableObjectState;
  vi.stubGlobal("Response", SocketResponse);
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = socket();
      1 = socket();
    },
  );
  const changes: Array<boolean> = [];
  const make = () =>
    new PreviewGateway({
      ctx,
      settings: previewSettings({ PREVIEW_DOMAIN: "*.preview.example" }),
      threadId: () => threadId,
      appOrigin: "https://cloud.example",
      now: () => now,
      leaseToken: async (asked: number, token?: string) =>
        asked === generation && (token === undefined || token === `lease-${generation}`)
          ? `lease-${generation}`
          : null,
      canSee: async (userId: string) => member && userId === "member",
      configuration: async () => configuration,
      saveServices: async (services: ReadonlyArray<typeof service>) => {
        configuration = { ...configuration, services };
      },
      drive: async () => null,
      holdChanged: async () => {
        changes.push(gateway.held);
      },
      browsed: async () => false,
      storeStep: async () => undefined,
      logError: () => undefined,
    });
  const gateway = make();
  const tunnel = async (askedGeneration = generation) => {
    const ws = socket();
    sockets.set(ws, ["preview-tunnel"]);
    const say = (frame: TunnelRunnerMessage) =>
      gateway.onTunnelMessage(ws as unknown as WebSocket, tunnelRunnerFrame.encode(frame));
    await say({
      type: "hello",
      version: PREVIEW_TUNNEL_VERSION,
      threadId,
      generation: askedGeneration,
      token: `lease-${askedGeneration}`,
    });
    return { ws, say };
  };
  const signIn = async () => {
    const link = await gateway.link("member", 5173, true);
    if (link._tag !== "ok") throw new Error(link.message);
    const signedIn = await gateway.serve(new Request(link.url))!;
    expect(signedIn.status).toBe(302);
    const cookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
    return { origin: new URL(link.url).origin, cookie, url: link.url };
  };
  return {
    gateway,
    make,
    tunnel,
    signIn,
    changes,
    sockets,
    advance: (ms: number) => {
      now += ms;
    },
    nextMachine: () => {
      generation += 1;
    },
    revoke: () => {
      member = false;
    },
  };
};

describe("opening a thread preview", () => {
  it("tells the runner which deployment hosts its public previews", async () => {
    const f = fixture();
    const { ws } = await f.tunnel();
    expect(JSON.parse(String(ws.sent[0]))).toMatchObject({
      type: "welcome",
      previewHostSuffix: ".preview.example",
    });
  });

  it("lists and opens the declared server while the machine is stopped", async () => {
    const f = fixture();
    const subscription = (await f.gateway.subscribe("member"))!.getReader();
    const line = await subscription.read();
    expect(JSON.parse(new TextDecoder().decode(line.value))).toMatchObject({
      ports: [{ port: 5173 }],
    });
    await subscription.cancel();
    const signedIn = await f.signIn();
    const page = await f.gateway.serve(
      new Request(signedIn.origin, { headers: { cookie: signedIn.cookie } }),
    )!;
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Starting preview…");
  });

  it("keeps the browser credential valid after idle and a new machine generation", async () => {
    const f = fixture();
    const signedIn = await f.signIn();
    f.advance(60 * 60_000);
    f.nextMachine();
    const reopened = f.make();
    const page = await reopened.serve(
      new Request(signedIn.origin, { headers: { cookie: signedIn.cookie } }),
    )!;
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Starting preview…");
  });

  it("returns an app link that can be reopened later without carrying a credential", async () => {
    const f = fixture();
    expect(await f.gateway.link("member", 5173)).toEqual({
      _tag: "ok",
      url: "https://cloud.example/api/cloud/threads/thread-preview/previews/5173",
    });
    f.advance(60 * 60_000);
    f.nextMachine();
    expect(await f.make().link("member", 5173)).toEqual({
      _tag: "ok",
      url: "https://cloud.example/api/cloud/threads/thread-preview/previews/5173",
    });
  });

  it("sends expired handoff links back through browser sign-in", async () => {
    const f = fixture();
    const signedIn = await f.signIn();
    f.advance(60 * 60_000);
    const expired = await f.gateway.serve(
      new Request(signedIn.url, { headers: { accept: "text/html" } }),
    )!;
    expect(expired.status).toBe(302);
    expect(expired.headers.get("location")).toBe(
      "https://cloud.example/api/cloud/threads/thread-preview/previews/5173",
    );
  });

  it("checks membership before starting anything, including an old signed credential", async () => {
    const f = fixture();
    const signedIn = await f.signIn();
    f.revoke();
    expect((await f.gateway.link("member", 5173))._tag).toBe("unavailable");
    const denied = await f.gateway.serve(
      new Request(`${signedIn.origin}/__signalbox_preview/lease`, {
        headers: { cookie: signedIn.cookie, upgrade: "websocket" },
      }),
    )!;
    expect(denied.status).toBe(403);
    expect(f.gateway.held).toBe(false);
    expect(f.changes).toEqual([]);
  });

  it("holds a lease independently of HMR until the last preview tab closes", async () => {
    const f = fixture();
    const signedIn = await f.signIn();
    const open = () =>
      f.gateway.serve(
        new Request(`${signedIn.origin}/__signalbox_preview/lease`, {
          headers: { cookie: signedIn.cookie, upgrade: "websocket" },
        }),
      )!;
    expect((await open()).status).toBe(101);
    expect((await open()).status).toBe(101);
    expect(f.gateway.held).toBe(true);
    const views = [...f.sockets]
      .filter(([, tags]) => tags.includes("preview-view"))
      .map(([ws]) => ws);
    expect(views).toHaveLength(2);
    f.advance(1_000);
    await f.gateway.onClientClose(views[0] as unknown as WebSocket);
    expect(f.gateway.held).toBe(true);
    f.advance(1_000);
    await f.gateway.onClientClose(views[1] as unknown as WebSocket);
    expect(f.gateway.held).toBe(false);
    expect(f.gateway.lastActiveAt).toBe(3_000);
    expect(f.changes).toEqual([true, false]);
  });

  it("starts the idle tail when the last tab closes after object hibernation", async () => {
    const f = fixture();
    const signedIn = await f.signIn();
    await f.gateway.serve(
      new Request(`${signedIn.origin}/__signalbox_preview/lease`, {
        headers: { cookie: signedIn.cookie, upgrade: "websocket" },
      }),
    )!;
    const view = [...f.sockets].find(([, tags]) => tags.includes("preview-view"))![0];
    const awakened = f.make();
    f.advance(10_000);
    await awakened.onClientClose(view as unknown as WebSocket);
    expect(awakened.held).toBe(false);
    expect(f.changes).toEqual([true, false]);
    expect(awakened.lastActiveAt).toBe(11_000);
  });

  it("keeps a newly opened tab's hold while an older machine is released", async () => {
    const f = fixture();
    const signedIn = await f.signIn();
    await f.tunnel();
    await f.gateway.serve(
      new Request(`${signedIn.origin}/__signalbox_preview/lease`, {
        headers: { cookie: signedIn.cookie, upgrade: "websocket" },
      }),
    )!;
    const view = [...f.sockets].find(([, tags]) => tags.includes("preview-view"))![0];
    await f.gateway.release(1);
    expect(view.readyState).toBe(WebSocket.OPEN);
    expect(f.gateway.held).toBe(true);
    expect(f.changes).toEqual([true]);
  });

  it("rejects a stale machine's tunnel and does not let it change declared services", async () => {
    const f = fixture();
    await f.gateway.subscribe("member").then((stream) => stream!.cancel());
    const old = await f.tunnel();
    f.nextMachine();
    await old.say({ type: "ports", ports: [{ port: 9999, processName: null }] });
    expect(old.ws.readyState).toBe(WebSocket.CLOSED);
    expect(f.gateway.ports()).toEqual([{ port: 5173, processName: null }]);
    expect((await f.tunnel(1)).ws.readyState).toBe(WebSocket.CLOSED);
  });
});
