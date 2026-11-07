export const ROUTES = [
  { method: "POST", path: "/sequence/hold" },
  { method: "GET", path: "/sequence/held" },
  { method: "POST", path: "/sequence/release" },
  { method: "GET", path: "/ready" },
  { method: "POST", path: "/observer-calibration" },
  { method: "POST", path: "/claude/observer-calibration" },
  ...(["baseline", "hooks"] as const).map((variant) => ({
    method: "POST",
    path: `/claude/${variant}/calibration`,
  })),
  { method: "POST", path: "/claude/thread/dispatch" },
  { method: "GET", path: "/claude/thread/receipt" },
  ...[1, 2, 3].flatMap((turn) => [
    { method: "POST", path: `/turn/${turn}/dispatch` },
    { method: "GET", path: `/turn/${turn}/receipt` },
  ]),
  { method: "POST", path: "/replace/dispatch" },
  { method: "GET", path: "/replace/receipt" },
  { method: "POST", path: "/finish/dispatch" },
  { method: "GET", path: "/finish/receipt" },
  { method: "GET", path: "/export/page" },
  { method: "POST", path: "/export/blob" },
] as const;
