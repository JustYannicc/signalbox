/** Cloud Worker, ModelGateway Worker, and Runner API dev ports. */
const CONTROL_PLANE_PORTS = new Set([8787, 8788, 8790]);

/** Whether a TCP port can be exposed as a thread preview. */
export const isPreviewPortAllowed = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65_535 && !CONTROL_PLANE_PORTS.has(port);
