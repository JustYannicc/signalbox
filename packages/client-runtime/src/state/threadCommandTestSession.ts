import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { vi } from "vite-plus/test";

export const testConfigAtoms = Atom.family((_id: EnvironmentId) =>
  Atom.make({
    environment: {
      capabilities: { signalboxCloud: false, threadPinning: true, threadPinReorder: true },
    },
  }),
);
export const testSessionAtoms = Atom.family((_id: EnvironmentId) =>
  Atom.make<AuthSessionState | null>({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationOperateScope],
    permissions: [AuthOrchestrationOperateScope],
  }),
);
const sessionResults = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => {
    const session = get(testSessionAtoms(id));
    return session === null
      ? AsyncResult.initial<AuthSessionState, never>()
      : AsyncResult.success(session);
  }),
);
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    initialConfigValueAtom: testConfigAtoms,
    sessionStateValueAtom: testSessionAtoms,
    sessionStateAtom: sessionResults,
  }),
}));
