/**
 * Machine price tables the workload cost replay prices usage against (#116).
 * Each entry is one machine shape per active thread. When a provider changes
 * its prices, add a new entry with a new `id` and `checkedOn` instead of
 * editing rates in place, so older replays stay reproducible.
 */

export interface MachinePrice {
  readonly id: string;
  /** Column label in the replay table. */
  readonly label: string;
  /** When the rates were last read from `source`. */
  readonly checkedOn: string;
  readonly source: string;
  readonly shape: { readonly vcpu: number; readonly memoryGiB: number; readonly diskGB: number };
  /** Billed per vCPU-hour of CPU actually used, not per provisioned vCPU. */
  readonly activeCpuPerVcpuHour: number;
  /** Billed per hour awake for the whole shape (provisioned memory, disk, flat rates). */
  readonly awakePerHour: number;
}

export const MACHINE_PRICES: ReadonlyArray<MachinePrice> = [
  {
    id: "cloudflare-containers-2vcpu-6gib-2026-10-06",
    label: "Cloudflare 2 vCPU/6 GiB",
    checkedOn: "2026-10-06",
    source: "https://developers.cloudflare.com/containers/pricing/",
    shape: { vcpu: 2, memoryGiB: 6, diskGB: 12 },
    // $0.000020 per vCPU-second used; memory $0.0000025/GiB-s and disk
    // $0.00000007/GB-s provisioned.
    activeCpuPerVcpuHour: 0.072,
    awakePerHour: 6 * 0.009 + 12 * 0.000252,
  },
  {
    id: "boat-2vcpu-4gb-2026-10-06",
    label: "boat 2 vCPU/4 GB",
    checkedOn: "2026-10-06",
    source: "https://boat.dev/pricing",
    shape: { vcpu: 2, memoryGiB: 4, diskGB: 0 },
    activeCpuPerVcpuHour: 0,
    awakePerHour: 0.018,
  },
  {
    id: "blaxel-4gb-2026-10-06",
    label: "Blaxel 4 GB",
    checkedOn: "2026-10-06",
    source: "https://blaxel.ai/pricing",
    shape: { vcpu: 2, memoryGiB: 4, diskGB: 0 },
    // $0.0000115 per GB-second awake; CPU is included.
    activeCpuPerVcpuHour: 0,
    awakePerHour: 4 * 0.0000115 * 3600,
  },
  {
    id: "vercel-sandbox-2vcpu-4gb-2026-10-06",
    label: "Vercel 2 vCPU/4 GB",
    checkedOn: "2026-10-06",
    source: "https://vercel.com/docs/vercel-sandbox/pricing",
    shape: { vcpu: 2, memoryGiB: 4, diskGB: 0 },
    // Active CPU $0.128/vCPU-hour; provisioned memory $0.0212/GB-hour.
    activeCpuPerVcpuHour: 0.128,
    awakePerHour: 4 * 0.0212,
  },
];
