const NodeFS = require("node:fs");

const writeFileSync = NodeFS.writeFileSync;
const stdoutWrite = process.stdout.write;
let replied = false;

process.stdout.write = function (...args) {
  replied = true;
  return stdoutWrite.apply(this, args);
};

NodeFS.writeFileSync = function (file, data, ...args) {
  if (
    typeof file !== "string" ||
    !file.startsWith(process.env.T3_ACP_REPLAY_STATUS_PATH) ||
    JSON.parse(String(data)).cursor !== 2
  ) {
    return writeFileSync(file, data, ...args);
  }

  // Hold the write after truncation so the parent can stop at the reply boundary.
  const descriptor = NodeFS.openSync(file, "w");
  writeFileSync(3, replied ? "after\n" : "before\n");
  NodeFS.readSync(4, Buffer.alloc(1), 0, 1, null);
  try {
    return writeFileSync(descriptor, data, ...args);
  } finally {
    NodeFS.closeSync(descriptor);
  }
};
