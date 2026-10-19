// @effect-diagnostics nodeBuiltinImport:off - this local proof owns the exact tunnel child it spawns.
import * as NodeChildProcess from "node:child_process";

/** The callback tunnel carries only this disposable Worker's private protocol. */
export async function openLocalProofTunnel(origin: string) {
  const child = NodeChildProcess.spawn(
    process.env.CLOUDFLARED_BIN ?? "cloudflared",
    ["tunnel", "--url", origin, "--no-autoupdate"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const url = await new Promise<URL>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Local proof tunnel startup timed out")),
        30_000,
      );
      const finish = (error?: Error, value?: URL) => {
        clearTimeout(timer);
        child.stdout.off("data", inspect);
        child.stderr.off("data", inspect);
        child.off("error", failed);
        child.off("exit", ended);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const inspect = (bytes: Buffer) => {
        output = (output + bytes.toString("utf8")).slice(-32_768);
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u);
        if (match) finish(undefined, new URL(match[0]));
      };
      const failed = () => finish(new Error("Local proof tunnel could not start"));
      const ended = () => finish(new Error("Local proof tunnel exited before readiness"));
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", failed);
      child.once("exit", ended);
    });
    // Drain later output without writing private callback URLs to logs.
    child.stdout.resume();
    child.stderr.resume();
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
