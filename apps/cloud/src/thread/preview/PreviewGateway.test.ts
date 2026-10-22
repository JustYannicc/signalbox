import {
  PREVIEW_TUNNEL_VERSION,
  DATA_KIND,
  dataFrame,
  tunnelThreadFrame,
  type TunnelRunnerMessage,
  tunnelRunnerFrame,
} from "@signalbox/runner-protocol/PreviewTunnel";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { PreviewGateway } from "./PreviewGateway.ts";
import { previewSettings } from "./previewHost.ts";
import { previewToken } from "./previewToken.ts";

const threadId = ThreadId.make("thread-preview");
const service = { port: 5173, command: "pnpm dev --host 0.0.0.0", cwd: "." };

const socket = () => {
  let attachment: unknown = null;
  const sent: Array<string | Uint8Array> = [];
  return {
    readyState: Number(WebSocket.OPEN),
    sent,
    onSend: null as ((value: string | Uint8Array) => void) | null,
    serializeAttachment: (value: unknown) => {
      attachment = structuredClone(value);
    },
    deserializeAttachment: () => structuredClone(attachment),
    send(value: string | Uint8Array) {
      sent.push(value);
      this.onSend?.(value);
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

const fixture = (options: { files?: (request: Request) => Promise<Response | null> } = {}) => {
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
    "HTMLRewriter",
    class {
      on() {
        return this;
      }
      transform(response: Response) {
        return response;
      }
    },
  );
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
      ...options,
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
  it("keeps the Files slot anonymous when a tunnel reports a process on its reserved port", async () => {
    const f = fixture({ files: async () => null });
    const tunnel = await f.tunnel();
    await tunnel.say({ type: "ports", ports: [{ port: 80, processName: "nginx" }] });
    expect(f.gateway.ports().find((port) => port.port === 80)).toEqual({
      port: 80,
      processName: null,
    });
  });
  it("keeps the requested path and expires agent sessions with their ticket", async () => {
    const f = fixture();
    const link = await f.gateway.link("member", 5173, true, {
      agent: true,
      path: "/site/index.html?x=1#part",
    });
    if (link._tag !== "ok") throw new Error(link.message);
    f.advance(30_000);
    const opened = await f.gateway.serve(new Request(link.url))!;
    expect(opened.headers.get("location")).toBe("/site/index.html?x=1#part");
    expect(opened.headers.get("set-cookie")).toContain("Max-Age=90");
    const cookie = opened.headers.get("set-cookie")!.split(";", 1)[0]!;
    const request = () =>
      new Request(new URL("/site/index.html", link.url).toString(), { headers: { cookie } });
    expect((await f.gateway.serve(request())!).status).toBe(200);
    const watching = await f.gateway.serve(
      new Request(new URL("/__signalbox_preview/lease", link.url), {
        headers: { cookie, upgrade: "websocket" },
      }),
    )!;
    expect(watching.status).toBe(101);
    expect(f.gateway.held).toBe(true);
    f.advance(90_000);
    expect((await f.gateway.serve(request())!).status).toBe(404);
    expect(f.gateway.held).toBe(false);
  });

  it("hides missing, forged, cross-thread and wrong-port credentials", async () => {
    const f = fixture();
    const signedIn = await f.signIn();
    for (const credential of [
      null,
      "invalid",
      await previewToken("thread-signing-key-independent-of-machine", {
        k: "session",
        t: "another-thread",
        u: "member",
        p: 5173,
        exp: 99_000,
      }),
      await previewToken("thread-signing-key-independent-of-machine", {
        k: "session",
        t: threadId,
        u: "member",
        p: 5174,
        exp: 99_000,
      }),
    ]) {
      const response = await f.gateway.serve(
        new Request(signedIn.origin, {
          headers: credential === null ? {} : { cookie: `signalbox_preview=${credential}` },
        }),
      )!;
      expect(response.status).toBe(404);
    }
  });

  it.each([8787, 8788, 8790, 0, 65536])(
    "does not open control or invalid port %s",
    async (port) => {
      const f = fixture();
      const tunnel = await f.tunnel();
      if (port > 0) await tunnel.say({ type: "ports", ports: [{ port, processName: null }] });
      expect((await f.gateway.link("member", port, true))._tag).toBe("unavailable");
      expect(f.gateway.ports().some((entry) => entry.port === port)).toBe(false);
    },
  );

  it.each(["//other.example/a", "/\\other.example/a", "https://other.example/a", "/bad\npath"])(
    "refuses unsafe redirect path %s",
    async (path) => {
      expect((await fixture().gateway.link("member", 5173, true, { path }))._tag).toBe(
        "unavailable",
      );
    },
  );

  it.each(["files", "machine"] as const)(
    "loads one multi-file page through the same authority on %s",
    async (placement) => {
      const content = new Map([
        [
          "/site/index.html",
          [
            "text/html",
            '<link rel="stylesheet" href="./style.css"><script src="./main.js"></script>',
          ],
        ],
        ["/site/style.css", ["text/css", "body{color:red}"]],
        ["/site/main.js", ["text/javascript", "console.log('preview')"]],
      ]);
      const source = (request: Request) => {
        const file = content.get(new URL(request.url).pathname);
        return new Response(file?.[1] ?? "Missing", {
          status: file ? 200 : 404,
          headers: { "content-type": file?.[0] ?? "text/plain" },
        });
      };
      const f = fixture({
        files: async (request) => (placement === "files" ? source(request) : null),
      });
      if (placement === "machine") {
        const tunnel = await f.tunnel();
        await tunnel.say({ type: "ports", ports: [{ port: 80, processName: null }] });
        tunnel.ws.onSend = (value) => {
          if (typeof value !== "string") return;
          const frame = tunnelThreadFrame.decode(value);
          if (frame.type !== "request") return;
          void (async () => {
            const response = source(new Request(`https://preview.test${frame.path}`));
            await tunnel.say({
              type: "head",
              stream: frame.stream,
              status: response.status,
              headers: [...response.headers],
            });
            const bytes = new Uint8Array(await response.arrayBuffer());
            const data = dataFrame(frame.stream, DATA_KIND.body, bytes);
            await f.gateway.onTunnelMessage(
              tunnel.ws as unknown as WebSocket,
              data.buffer as ArrayBuffer,
            );
            await tunnel.say({ type: "end", stream: frame.stream });
          })();
        };
      }
      const link = await f.gateway.link("member", 80, true, {
        agent: true,
        path: "/site/index.html",
      });
      if (link._tag !== "ok") throw new Error(link.message);
      expect(new URL(link.url).protocol).toBe("https:");
      const opened = await f.gateway.serve(new Request(link.url))!;
      expect(opened.headers.get("location")).toBe("/site/index.html");
      const cookie = opened.headers.get("set-cookie")!.split(";", 1)[0]!;
      for (const [path, [mime, body]] of content) {
        const response = await f.gateway.serve(
          new Request(new URL(path, link.url), { headers: { cookie } }),
        )!;
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(mime);
        expect(await response.text()).toContain(body);
      }
    },
  );

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

  it("answers 404 for expired handoff links", async () => {
    const f = fixture();
    const signedIn = await f.signIn();
    f.advance(60 * 60_000);
    const expired = await f.gateway.serve(
      new Request(signedIn.url, { headers: { accept: "text/html" } }),
    )!;
    expect(expired.status).toBe(404);
    expect(expired.headers.get("location")).toBeNull();
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
    expect(denied.status).toBe(404);
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
