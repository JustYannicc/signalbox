/**
 * PLACEHOLDER DATA. Visible computer sessions have no backend yet; these
 * fixtures only drive the `/computers` prototype.
 */
import type { Computer, ComputerStep } from "./computerModel";

const MB = 1024 ** 2;

function standardSteps(
  statuses: readonly [
    ComputerStep["status"],
    ComputerStep["status"],
    ComputerStep["status"],
    ComputerStep["status"],
  ],
  details: readonly [string, string, string, string],
): ReadonlyArray<ComputerStep> {
  const labels = ["Acquire computer", "Sync files", "Run tests", "Take screenshot"] as const;
  const minutes = [0, 1, 4, 11] as const;
  return labels.map((label, index) => ({
    id: `step-${index}`,
    label,
    detail: details[index] ?? "",
    status: statuses[index] ?? "pending",
    atMinute: statuses[index] === "pending" ? null : (minutes[index] ?? null),
  }));
}

export const COMPUTERS: ReadonlyArray<Computer> = [
  {
    id: "cmp-landing-page",
    name: "landing-page-preview",
    os: "linux",
    osVersion: "Ubuntu 24.04",
    provider: "Cloudflare Containers",
    region: "Frankfurt (fra)",
    size: "4 vCPU · 8 GB",
    acquiredBy: { kind: "task", title: "Build landing page", sharedThreadId: null },
    state: "live",
    minutes: 12,
    computeUsd: 0.072,
    storageUsd: 0.004,
    computeRateUsdPerHour: 0.36,
    retainedGb: 6.2,
    browserUrl: "localhost:5173",
    lastSyncMinutesAgo: 0,
    steps: standardSteps(
      ["done", "done", "done", "running"],
      [
        "Chose Linux: cheapest option with Chromium",
        "Pulled 214 files from the durable workspace",
        "vitest: 48 passed · playwright: 6 passed",
        "Capturing hero at 1440 and 390 wide",
      ],
    ),
    artifacts: [
      { name: "hero-1440.png", kind: "screenshot", bytes: 1.8 * MB },
      { name: "hero-390.png", kind: "screenshot", bytes: 0.6 * MB },
      { name: "playwright-report.html", kind: "report", bytes: 3.4 * MB },
      { name: "dev-server.log", kind: "log", bytes: 42 * 1024 },
    ],
  },
  {
    id: "cmp-receipt-printing",
    name: "receipt-print-repro",
    os: "windows",
    osVersion: "Windows 11 24H2",
    provider: "Orgo",
    region: "Virginia (us-east)",
    size: "4 vCPU · 16 GB",
    acquiredBy: {
      kind: "task",
      title: "Ship A920 receipt printer fix",
      sharedThreadId: "ta-printer-fix",
    },
    state: "live",
    minutes: 41,
    computeUsd: 0.54,
    storageUsd: 0.011,
    computeRateUsdPerHour: 0.79,
    retainedGb: 18.4,
    browserUrl: "localhost:3000/receipts/1042",
    lastSyncMinutesAgo: 2,
    steps: standardSteps(
      ["done", "done", "failed", "pending"],
      [
        "Chose Windows: the receipt preview only breaks in Edge",
        "Pulled 88 files from the durable workspace",
        "receipt-preview.spec: 1 failed",
        "Waiting for the test fix",
      ],
    ),
    artifacts: [
      { name: "receipt-preview-diff.png", kind: "screenshot", bytes: 2.2 * MB },
      { name: "edge-console.log", kind: "log", bytes: 118 * 1024 },
    ],
  },
  {
    id: "cmp-refund-e2e",
    name: "refund-e2e",
    os: "linux",
    osVersion: "Debian 12",
    provider: "Daytona",
    region: "Amsterdam (eu-west)",
    size: "8 vCPU · 16 GB",
    acquiredBy: {
      kind: "task",
      title: "Fix refund webhook retries",
      sharedThreadId: "mp-refund-webhooks",
    },
    state: "paused",
    minutes: 128,
    computeUsd: 1.12,
    storageUsd: 0.03,
    computeRateUsdPerHour: 0.64,
    retainedGb: 24,
    browserUrl: "localhost:4173/refunds",
    lastSyncMinutesAgo: 128,
    steps: standardSteps(
      ["done", "done", "done", "done"],
      [
        "Chose Linux: parallel browsers on one machine",
        "Pulled 1,902 files from the durable workspace",
        "playwright: 212 passed · 3 flaky",
        "Captured 3 flaky refund states",
      ],
    ),
    artifacts: [
      { name: "flaky-refund.png", kind: "screenshot", bytes: 1.1 * MB },
      { name: "trace-refund.zip", kind: "archive", bytes: 38 * MB },
      { name: "e2e-summary.json", kind: "report", bytes: 64 * 1024 },
    ],
  },
  {
    id: "cmp-payout-safari",
    name: "payout-safari-check",
    os: "macos",
    osVersion: "macOS 15 Sequoia",
    provider: "Cua",
    region: "Oregon (us-west)",
    size: "M2 · 8 GB",
    acquiredBy: {
      kind: "task",
      title: "Review payout dashboard copy",
      sharedThreadId: "mp-payout-copy",
    },
    state: "released",
    minutes: 60 * 26,
    computeUsd: 0.94,
    storageUsd: 0,
    computeRateUsdPerHour: 1.1,
    retainedGb: 0,
    browserUrl: "localhost:5173/payouts",
    lastSyncMinutesAgo: 60 * 26,
    steps: standardSteps(
      ["done", "done", "done", "done"],
      [
        "Chose macOS: Safari only",
        "Pulled 214 files from the durable workspace",
        "Manual check: payout copy wraps cleanly in Safari 18",
        "Captured before and after",
      ],
    ),
    artifacts: [
      { name: "payouts-before.png", kind: "screenshot", bytes: 1.4 * MB },
      { name: "payouts-after.png", kind: "screenshot", bytes: 1.4 * MB },
    ],
  },
];

export function findComputer(id: string): Computer | undefined {
  return COMPUTERS.find((computer) => computer.id === id);
}
