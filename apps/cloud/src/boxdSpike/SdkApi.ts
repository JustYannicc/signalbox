// @effect-diagnostics globalDate:off globalFetch:off - The SDK adapter uses provider wall-clock deadlines and checks the public route without an Effect runtime.
import { Boxd, NotFoundError } from "@boxd-sh/sdk/web";
import * as Schema from "effect/Schema";
import { CLONE_WORKLOAD } from "./cloneWorkload.ts";
import type { Owned, ProbeApi } from "./Probe.ts";

const DEAD_PORT = 65535;
const ROOT = "/tmp/signalbox-boxd-spike";
const decodeStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.NullOr(
      Schema.Struct({
        pid: Schema.Number,
        birth: Schema.String,
        observed: Schema.String,
        waiting: Schema.Boolean,
        leasePresent: Schema.Boolean,
        cleared: Schema.Boolean,
        configRemoved: Schema.Boolean,
        reconnects: Schema.Number,
      }),
    ),
  ),
);

export interface SdkConfig {
  readonly owner: string;
  readonly org: string;
  readonly image: string;
  readonly egressAllow: readonly string[];
}

export const sdkClient = (token: string) =>
  new Boxd({
    token,
    baseURL: "https://boxd.sh:9443",
    timeout: 10_000,
    // Provider create/fork have no idempotency keys. Never repeat a timed-out mutation.
    maxRetries: 0,
  });

const optional = async <A>(run: () => Promise<A>): Promise<A | null> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
};

export function makeSdkApi(client: Boxd, config: SdkConfig): ProbeApi["Service"] {
  const source = `${config.owner}-source`;
  const clone = `${config.owner}-clone`;
  const snapshot = `${config.owner}-snapshot`;
  const snapshotContext = config.org ? { org: config.org } : {};
  const get = (name: string) => optional(() => client.machines.get(name));
  const exec = async (machine: string, command: string[]) => {
    const result = await client.machines.exec(machine, { command, timeout: 5_000 });
    if (result.exitCode !== 0) throw new Error("Boxd probe workload failed.");
    return result.stdout;
  };
  const status = async (machine: string) =>
    decodeStatus(
      await exec(machine, [
        "python3",
        "-c",
        `import pathlib; p=pathlib.Path("${ROOT}/status.json"); print(p.read_text() if p.exists() else "null")`,
      ]),
    );
  const ttl = (deadline: number) => Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  const publicBlocked = async (name: string) => {
    const machine = await client.machines.get(name);
    const url = new URL(machine.access.url);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid public route.");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    if (![403, 404, 502, 503].includes(response.status))
      throw new Error("Public route did not fail closed.");
  };
  const ready = { ready: true };
  const pending = { ready: false };

  const secure = async (name: string, deadline: number) => {
    const machine = await get(name);
    if (!machine || machine.status !== "running") return pending;
    if (!machine.networking.isolated || machine.networking.networks.length !== 0) {
      throw new Error("Boxd isolation mismatch.");
    }
    await client.machines.proxies.setPort(name, DEAD_PORT);
    await client.machines.setDeleteAfter(name, ttl(deadline));
    await client.machines.setEgressAllow(name, [...config.egressAllow]);
    await client.machines.setAutoHibernateTimeout(name, 3600);
    const proxies = await client.machines.proxies.list(name);
    if (
      proxies.length !== 1 ||
      !proxies[0]?.isDefault ||
      proxies[0].port !== DEAD_PORT ||
      proxies[0].portMode !== "locked"
    ) {
      throw new Error("Boxd proxy mismatch.");
    }
    // The workload must never bind this port, including after a clone.
    await exec(name, [
      "python3",
      "-c",
      "import socket; s=socket.socket(); s.bind(('0.0.0.0',65535)); s.close()",
    ]);
    const refreshed = await client.machines.get(name);
    if (
      !refreshed.deleteAt ||
      refreshed.deleteAt.getTime() > deadline + 5_000 ||
      [...refreshed.egressAllow].sort().join(",") !== [...config.egressAllow].sort().join(",")
    ) {
      throw new Error("Boxd deadline or egress mismatch.");
    }
    return { ready: true, metrics: { [name === source ? "sourcePrivate" : "clonePrivate"]: 1 } };
  };

  const cleanup = async (owned: Owned) => {
    // Exact reserved names only. No prefix scan can touch another run's resources.
    let absent = true;
    for (const name of [...(owned.clone ? [clone] : []), ...(owned.source ? [source] : [])]) {
      try {
        const machine = await get(name);
        if (machine) {
          await optional(() => client.machines.delete(machine.id));
          if (await get(name)) absent = false;
        }
      } catch {
        absent = false;
      }
    }
    if (owned.snapshot) {
      try {
        if (await optional(() => client.snapshots.get(snapshot, snapshotContext))) {
          await optional(() => client.snapshots.delete(snapshot, snapshotContext));
          if (await optional(() => client.snapshots.get(snapshot, snapshotContext))) absent = false;
        }
      } catch {
        absent = false;
      }
    }
    return absent;
  };

  return {
    cleanup,
    step: async (step, attempted, deadline) => {
      switch (step) {
        case "connect": {
          const machines = await client.machines.list(snapshotContext);
          if (
            machines.some((machine) => machine.name === source || machine.name === clone) ||
            (await optional(() => client.snapshots.get(snapshot, snapshotContext)))
          ) {
            throw new Error("Probe names already exist. Use a fresh stage.");
          }
          return ready;
        }
        case "create": {
          if (!attempted) {
            // No agent or server starts before private routing is verified in the next step.
            await client.machines.create({
              name: source,
              org: config.org,
              image: config.image,
              isolated: true,
              networks: [],
              shared: false,
              deleteAfter: ttl(deadline),
              cmd: ["sleep", "infinity"],
              restartPolicy: "never",
              config: {
                vcpu: 1,
                memory: "4G",
                ssh: false,
                autoDestroyTimeout: ttl(deadline),
                idleIgnoreOutbound: true,
              },
            });
          }
          return { ready: (await get(source)) !== null };
        }
        case "private":
          return secure(source, deadline);
        case "workload": {
          const state = await status(source);
          if (!state) {
            const hostname = (await exec(source, ["hostname"])).trim();
            if (hostname !== source) throw new Error("Boxd hostname is not the machine name.");
            await exec(source, ["mkdir", "-p", ROOT]);
            await client.machines.files.upload(source, `${ROOT}/guard.py`, CLONE_WORKLOAD);
            await client.machines.files.upload(
              source,
              `${ROOT}/config.json`,
              JSON.stringify({ identity: source, generation: "source" }),
            );
            await exec(source, [
              "sh",
              "-c",
              `nohup flock -n ${ROOT}/guard.lock python3 ${ROOT}/guard.py </dev/null >/dev/null 2>&1 &`,
            ]);
            return pending;
          }
          if (
            state.birth !== source ||
            state.observed !== source ||
            !state.leasePresent ||
            state.waiting
          )
            throw new Error("Invalid source guard.");
          await publicBlocked(source);
          return { ready: true, metrics: { sourcePid: state.pid, sourcePublicBlocked: 1 } };
        }
        case "hibernate":
          if (!attempted) await client.machines.hibernate(source);
          return { ready: (await get(source))?.status === "hibernated" };
        case "wake": {
          if (!attempted) await client.machines.wake(source);
          if ((await get(source))?.status !== "running") return pending;
          const state = await status(source);
          if (!state) return pending;
          return { ready: state.leasePresent && !state.waiting, metrics: { wakePid: state.pid } };
        }
        case "snapshot":
          if (!attempted) await client.snapshots.create(source, snapshot);
          return {
            ready:
              (await optional(() => client.snapshots.get(snapshot, snapshotContext)))?.status ===
              "ready",
          };
        case "fork":
          if (!attempted)
            await client.machines.fork(source, {
              name: clone,
              isolated: true,
              networks: [],
              shared: false,
              deleteAfter: ttl(deadline),
            });
          return { ready: (await get(clone)) !== null };
        case "fork-private":
          return secure(clone, deadline);
        case "clone-wait": {
          const state = await status(clone);
          if (!state) return pending;
          if (state.observed !== clone) return pending;
          if (!state) return pending;
          if (
            state.birth !== source ||
            !state.waiting ||
            state.leasePresent ||
            !state.cleared ||
            !state.configRemoved ||
            state.reconnects !== 0
          ) {
            throw new Error("Cloned lease was not cleared before reconnect.");
          }
          return {
            ready: true,
            metrics: { clonePid: state.pid, cloneLeaseCleared: 1, cloneWaitedForConfig: 1 },
          };
        }
        case "clone-config":
          await client.machines.files.upload(
            clone,
            `${ROOT}/config.json`,
            JSON.stringify({ identity: clone, generation: "child" }),
          );
          return ready;
        case "clone-ready": {
          const state = await status(clone);
          if (!state || state.waiting) return pending;
          if (
            !state.leasePresent ||
            !state.cleared ||
            state.reconnects !== 1 ||
            state.observed !== clone
          )
            throw new Error("Fresh clone config rejected.");
          await publicBlocked(clone);
          return { ready: true, metrics: { cloneFreshConfigAccepted: 1, clonePublicBlocked: 1 } };
        }
        case "usage": {
          const report = await client.machines.usage(source, snapshotContext);
          if (report.currency !== "eur" && report.currency !== "usd")
            throw new Error("Unknown usage currency.");
          return {
            ready: true,
            usage: {
              costMicro: report.costMicro,
              currency: report.currency,
              complete: report.complete,
            },
          };
        }
        case "release":
          if (!attempted) await client.machines.hibernate(clone);
          return { ready: (await get(clone))?.status === "hibernated" };
        case "archive":
          return { ready: await cleanup({ source: true, clone: true, snapshot: true }) };
      }
    },
  };
}
