import type { WasiDescriptor, WasiStdio } from "../wasi/internal_wasi_descriptors.ts";
import type { KernelStat } from "./KernelFileSystemTypes.ts";

export type KernelDeviceName = "null" | "zero" | "random";

export interface DeviceInfo {
  readonly name: KernelDeviceName;
  readonly ino: bigint;
}

const deviceInfos = new Map<string, DeviceInfo>([
  ["/dev/null", { name: "null", ino: 1n }],
  ["/dev/zero", { name: "zero", ino: 2n }],
  ["/dev/random", { name: "random", ino: 3n }],
]);
const infoByStdio = new WeakMap<WasiStdio, DeviceInfo>();
const streams = new Map<KernelDeviceName, WasiStdio>();

export function virtualDevice(path: string): DeviceInfo | undefined {
  return deviceInfos.get(path);
}

export function virtualDevicePath(name: KernelDeviceName): string {
  return `/dev/${name}`;
}

export function virtualDeviceStdio(name: KernelDeviceName): WasiStdio {
  let stdio = streams.get(name);
  if (stdio !== undefined) return stdio;

  stdio = {
    readInto: (target) => {
      if (name === "null") return 0;
      if (name === "zero") {
        target.fill(0);
        return target.byteLength;
      }
      for (let offset = 0; offset < target.byteLength; offset += 65_536) {
        const random = new Uint8Array(Math.min(65_536, target.byteLength - offset));
        globalThis.crypto.getRandomValues(random);
        target.set(random, offset);
      }
      return target.byteLength;
    },
    write: (source) => source.byteLength,
    sync: () => undefined,
  };
  infoByStdio.set(stdio, deviceInfos.get(virtualDevicePath(name))!);
  streams.set(name, stdio);
  return stdio;
}

export function deviceInfoForDescriptor(descriptor: WasiDescriptor): DeviceInfo | undefined {
  return descriptor.stdio === undefined ? undefined : infoByStdio.get(descriptor.stdio);
}

export function deviceStat(info: DeviceInfo): KernelStat {
  return {
    type: "character",
    size: 0n,
    nlink: 1n,
    atimeNs: 0n,
    mtimeNs: 0n,
    ctimeNs: 0n,
    ino: info.ino,
    dev: 0n,
  };
}
