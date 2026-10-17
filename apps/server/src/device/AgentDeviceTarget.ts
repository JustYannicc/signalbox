import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { AgentDeviceEndpoint } from "./DeviceHost.ts";
import { AGENT_DEVICE_PROXY_ROUTE_PREFIX } from "./AgentDeviceProxyProtocol.ts";
import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";
import { sameAgentDeviceSession, type AgentDeviceSession } from "./AgentDeviceSession.ts";

const encodeEndpoint = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ daemonBaseUrl: Schema.String, daemonAuthToken: Schema.String }),
  ),
);

const key = Effect.fn("AgentDeviceTarget.key")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(value))
    .pipe(Effect.orDie);
  return Hex.encode(digest).slice(0, 24);
});

export const agentDeviceConfigDir = (stateDir: string, hostId: string, path: Path.Path) =>
  key(hostId).pipe(Effect.map((hash) => path.join(stateDir, "device", "hosts", hash)));

const sessionIdentity = (session: AgentDeviceSession) =>
  JSON.stringify([
    session.leaseId,
    session.sessionId,
    session.ownerKind,
    session.providerSessionId,
    session.threadId,
    session.hostId,
    session.deviceId,
  ]);

/** Each exact lease gets its own config so an old provider cannot read a replacement target. */
export const agentDeviceConfigPath = (
  stateDir: string,
  session: AgentDeviceSession,
  path: Path.Path,
) =>
  Effect.all([
    agentDeviceConfigDir(stateDir, session.hostId, path),
    key(sessionIdentity(session)),
  ]).pipe(Effect.map(([directory, hash]) => path.join(directory, `${hash}.json`)));

export const agentDeviceProxyBaseUrl = (port: number, sessionId: string) =>
  `http://127.0.0.1:${port}${AGENT_DEVICE_PROXY_ROUTE_PREFIX}/${encodeURIComponent(sessionId)}/`;

export const writeAgentDeviceConfig = Effect.fn("AgentDeviceTarget.writeConfig")(function* (
  file: string,
  endpoint: AgentDeviceEndpoint,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const content = yield* encodeEndpoint({
    daemonBaseUrl: endpoint.baseUrl,
    daemonAuthToken: endpoint.token,
  });
  if ((yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))) === content) return;
  const temporary = yield* fs.makeTempFile({ directory: path.dirname(file), prefix: ".endpoint-" });
  yield* Effect.gen(function* () {
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, content);
    yield* fs.rename(temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});

export const configureAgentDeviceSession = Effect.fn("AgentDeviceTarget.configureSession")(
  function* (input: {
    readonly stateDir: string;
    readonly serverPort: number;
    readonly session: AgentDeviceSession;
    readonly endpoint: AgentDeviceEndpoint;
  }) {
    const crypto = yield* Crypto.Crypto;
    const registry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
    const path = yield* Path.Path;
    const configPath = yield* agentDeviceConfigPath(input.stateDir, input.session, path);
    const existing = yield* registry.get(input.session.sessionId);
    const proxyToken =
      existing !== null &&
      existing.configPath === configPath &&
      sameAgentDeviceSession(existing.session, input.session)
        ? existing.proxyToken
        : yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    yield* writeAgentDeviceConfig(configPath, {
      ...input.endpoint,
      baseUrl: agentDeviceProxyBaseUrl(input.serverPort, input.session.sessionId),
      token: proxyToken,
    });
    yield* registry.register({
      session: input.session,
      configPath,
      proxyToken,
      endpoint: input.endpoint,
    });
    return configPath;
  },
);
