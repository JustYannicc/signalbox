// @effect-diagnostics globalDate:off - SDK response fixtures contain JavaScript Date values.
import { NotFoundError } from "@boxd-sh/sdk/web";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeSdkApi, sdkClient } from "../SdkApi.ts";

const source = "sb-boxd-spike-12345678-source";
const clone = "sb-boxd-spike-12345678-clone";
const machine = (name = source) => ({
  id: name,
  name,
  status: "running" as const,
  imageRef: "test",
  restartPolicy: null,
  createdAt: null,
  resources: { vcpu: 1, memoryBytes: 2 ** 32, diskBytes: 0 },
  org: null,
  shared: false,
  networking: { isolated: true, networks: [] },
  egressAllow: ["example.invalid"],
  access: {
    sshPort: null,
    domain: "boxd.sh",
    url: `https://${name}.boxd.sh`,
    desktopUrl: "",
    customDomains: [],
  },
  idle: { suspendAfter: 0, hibernateAfter: 3600, destroyAfter: 900 },
  botProtection: true,
  botProtectionMode: "on" as const,
  idleIgnoreOutbound: true,
  deleteAt: new Date(Date.now() + 900_000),
  deleteAfterCron: null,
  source: null,
  hibernatedAt: null,
  lastConnectedAt: null,
  bootTimeMs: null,
  pausedAutomations: 0,
});
const fixture = () => {
  const client = sdkClient("test-token");
  const api = makeSdkApi(client, {
    owner: "sb-boxd-spike-12345678",
    org: "",
    image: "",
    egressAllow: ["example.invalid"],
  });
  return { client, api, deadline: Date.now() + 900_000 };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SDK boundary", () => {
  it("uses /web gRPC-web on 9443 with an explicit JWT and no mutation retries", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("unreachable"));
    vi.stubGlobal("fetch", fetch);
    const { client } = fixture();
    await expect(client.machines.list()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(url).origin).toBe("https://boxd.sh:9443");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer test-token");
    expect(new Headers(options.headers).get("content-type")).toContain("grpc-web");
    await client.close();
  });

  it("creates without peers or a server and sets a deletion deadline", async () => {
    const { client, api, deadline } = fixture();
    const create = vi.spyOn(client.machines, "create").mockResolvedValue(machine());
    vi.spyOn(client.machines, "get").mockResolvedValue(machine());
    await api.step("create", false, deadline);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        isolated: true,
        networks: [],
        shared: false,
        cmd: ["sleep", "infinity"],
        deleteAfter: expect.any(Number),
        config: expect.objectContaining({ ssh: false, vcpu: 1 }),
      }),
    );
    await api.step("create", true, deadline);
    expect(create).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("pins the default proxy before the workload and verifies isolation, egress and TTL", async () => {
    const { client, api, deadline } = fixture();
    vi.spyOn(client.machines, "get").mockResolvedValue(machine());
    const pin = vi.spyOn(client.machines.proxies, "setPort").mockResolvedValue();
    vi.spyOn(client.machines, "setDeleteAfter").mockResolvedValue(new Date(deadline));
    vi.spyOn(client.machines, "setEgressAllow").mockResolvedValue(["example.invalid"]);
    vi.spyOn(client.machines, "setAutoHibernateTimeout").mockResolvedValue();
    vi.spyOn(client.machines.proxies, "list").mockResolvedValue([
      {
        name: null,
        machineId: source,
        machineName: source,
        domain: `${source}.boxd.sh`,
        port: 65535,
        portMode: "locked",
        isDefault: true,
      },
    ]);
    vi.spyOn(client.machines, "exec").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      success: true,
    });
    expect((await api.step("private", false, deadline)).ready).toBe(true);
    expect(pin).toHaveBeenCalledWith(source, 65535);
    vi.spyOn(client.machines, "get").mockResolvedValue({
      ...machine(),
      networking: { isolated: false, networks: [] },
    });
    await expect(api.step("private", true, deadline)).rejects.toThrow("isolation mismatch");
    await client.close();
  });

  it("refuses inherited credentials and accepts only a cleared clone waiting for config", async () => {
    const { client, api, deadline } = fixture();
    const exec = vi.spyOn(client.machines, "exec").mockResolvedValue({
      stdout: JSON.stringify({
        pid: 42,
        birth: source,
        observed: clone,
        waiting: false,
        leasePresent: true,
        cleared: false,
        configRemoved: false,
        reconnects: 1,
      }),
      stderr: "",
      exitCode: 0,
      success: true,
    });
    await expect(api.step("clone-wait", false, deadline)).rejects.toThrow("lease was not cleared");
    exec.mockResolvedValue({
      stdout: JSON.stringify({
        pid: 42,
        birth: source,
        observed: clone,
        waiting: true,
        leasePresent: false,
        cleared: true,
        configRemoved: true,
        reconnects: 0,
      }),
      stderr: "",
      exitCode: 0,
      success: true,
    });
    expect((await api.step("clone-wait", true, deadline)).metrics).toEqual({
      clonePid: 42,
      cloneLeaseCleared: 1,
      cloneWaitedForConfig: 1,
    });
    await client.close();
  });

  it("cleans only the reserved source, clone and snapshot names and verifies deletion", async () => {
    const { client, api } = fixture();
    const names = new Set([source, clone]);
    const get = vi.spyOn(client.machines, "get").mockImplementation(async (name) => {
      if (names.has(name)) return machine(name);
      throw new NotFoundError("gone");
    });
    const remove = vi.spyOn(client.machines, "delete").mockImplementation(async (name) => {
      names.delete(name);
    });
    vi.spyOn(client.snapshots, "get").mockRejectedValue(new NotFoundError("gone"));
    expect(await api.cleanup({ source: true, clone: true, snapshot: true })).toBe(true);
    expect(remove.mock.calls.map(([name]) => name)).toEqual([clone, source]);
    expect(get.mock.calls.every(([name]) => name === clone || name === source)).toBe(true);
    await client.close();
  });
});

it("a failed clone deletion does not skip the source or snapshot cleanup", async () => {
  const { client, api } = fixture();
  const names = new Set([source, clone]);
  vi.spyOn(client.machines, "get").mockImplementation(async (name) => {
    if (names.has(name)) return machine(name);
    throw new NotFoundError("gone");
  });
  const remove = vi.spyOn(client.machines, "delete").mockImplementation(async (name) => {
    if (name === clone) throw new Error("retry later");
    names.delete(name);
  });
  const snapshots = vi.spyOn(client.snapshots, "get").mockRejectedValue(new NotFoundError("gone"));
  expect(await api.cleanup({ source: true, clone: true, snapshot: true })).toBe(false);
  expect(remove.mock.calls.map(([name]) => name)).toEqual([clone, source]);
  expect(snapshots).toHaveBeenCalled();
  await client.close();
});

it("rejects a public route that still returns a successful response", async () => {
  const { client, api, deadline } = fixture();
  vi.spyOn(client.machines, "get").mockResolvedValue(machine(clone));
  vi.spyOn(client.machines, "exec").mockResolvedValue({
    stdout: JSON.stringify({
      pid: 42,
      birth: source,
      observed: clone,
      waiting: false,
      leasePresent: true,
      cleared: true,
      configRemoved: true,
      reconnects: 1,
    }),
    stderr: "",
    exitCode: 0,
    success: true,
  });
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response("unexpected public service", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await expect(api.step("clone-ready", false, deadline)).rejects.toThrow("did not fail closed");
  fetch.mockResolvedValue(new Response("blocked", { status: 503 }));
  expect((await api.step("clone-ready", true, deadline)).metrics?.clonePublicBlocked).toBe(1);
  await client.close();
});
