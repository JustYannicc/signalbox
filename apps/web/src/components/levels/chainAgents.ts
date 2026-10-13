/**
 * The agents on a level's chain, nearest first: the level's own agent, then
 * each one above it up to the top level, whose agent is the assistant
 * (`agentId: null`). These are who you'd ask from there; `@` offers them.
 */
import type { LevelOption } from "./levelOptions";
import { levelChain, type LevelKey } from "./levels";

export function chainAgents(
  level: LevelKey,
  options: readonly LevelOption[],
  placement?: Parameters<typeof levelChain>[1],
): readonly LevelOption[] {
  const byKey = new Map(options.map((option) => [option.key, option] as const));
  return levelChain(level, placement).flatMap((key) => byKey.get(key) ?? []);
}
