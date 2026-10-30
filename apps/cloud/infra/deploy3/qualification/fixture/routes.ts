export const ROUTES = [
  { method: "POST", path: "/sequence/hold" },
  { method: "GET", path: "/sequence/held" },
  { method: "POST", path: "/sequence/release" },
  { method: "GET", path: "/ready" },
  { method: "POST", path: "/observer-calibration" },
  ...(["baseline", "hooks"] as const).flatMap((variant) =>
    ["turn/1", "replace", "turn/2", "turn/3", "finish"].flatMap((step) => [
      { method: "POST", path: `/claude/${variant}/${step}/dispatch` },
      { method: "GET", path: `/claude/${variant}/${step}/receipt` },
    ]),
  ),
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
