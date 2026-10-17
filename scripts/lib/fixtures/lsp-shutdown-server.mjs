import * as NodeProcess from "node:process";

const mode = NodeProcess.argv[2];
let buffer = Buffer.alloc(0);
const frame = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};
const lateRequest = (id) => ({ id, method: "client/registerCapability", params: {} });

NodeProcess.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(
      buffer
        .subarray(0, headerEnd)
        .toString()
        .match(/Content-Length: (\d+)/)[1],
    );
    const end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString());
    buffer = buffer.subarray(end);
    if (message.method === "shutdown") {
      if (mode === "missing-ack") NodeProcess.exit(0);
      if (mode === "error-ack") {
        NodeProcess.stdout.write(
          frame({ id: message.id, error: { code: -32603, message: "failed" } }),
        );
      } else {
        // Coalescing these frames catches clients that set shutdown state only after awaiting the response.
        NodeProcess.stdout.write(
          frame({ id: message.id, result: null }) + frame(lateRequest("same-chunk")),
        );
      }
    } else if (message.method === "exit") {
      if (mode === "signal") NodeProcess.kill(NodeProcess.pid, "SIGKILL");
      if (mode === "panic")
        NodeProcess.stderr.write("panic: runtime error: invalid memory address\n");
      if (mode === "fatal") NodeProcess.stderr.write("fatal: unrelated failure\n");
      if (mode === "malformed") {
        NodeProcess.stdout.write("Content-Length: 1\r\n\r\n{");
      }
      NodeProcess.stderr.write("context canceled\nAdded new watch: program files\n");
      NodeProcess.stdout.write(frame(lateRequest("after-exit")), () =>
        NodeProcess.exit(Number(mode) || 0),
      );
    } else if (message.method) {
      NodeProcess.stdout.write(frame({ id: message.id, result: message.method }));
    } else {
      NodeProcess.stderr.write(`unexpected late response: ${message.id}\n`);
    }
  }
});
