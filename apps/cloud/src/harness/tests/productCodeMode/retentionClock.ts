let time = 0;
let nextTimer = 0;
const timers = new Map<number, { readonly deadline: number; readonly run: () => void }>();

export const retentionClock = {
  ttlMs: 100,
  get now() {
    return time;
  },
  get nextDeadline() {
    return [...timers.values()][0]?.deadline;
  },
  advance(milliseconds: number) {
    time += milliseconds;
    for (const [id, timer] of timers) {
      if (timer.deadline > time) continue;
      timers.delete(id);
      timer.run();
    }
  },
};

export const retentionDate = { now: () => time };
export function retentionSetTimeout(run: () => void, delay: number) {
  const id = ++nextTimer;
  timers.set(id, { deadline: time + delay, run });
  return id;
}
export function retentionClearTimeout(id: number | undefined) {
  if (id !== undefined) timers.delete(id);
}
