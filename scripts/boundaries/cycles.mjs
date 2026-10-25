// Kosaraju's two passes identify every cyclic edge, independent of traversal order.
export function cyclicViolations(modules) {
  const forward = new Map(modules.map((module) => [module.source, []]));
  const reverse = new Map(modules.map((module) => [module.source, []]));
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (!forward.has(dependency.resolved)) continue;
      forward.get(module.source).push(dependency.resolved);
      reverse.get(dependency.resolved).push(module.source);
    }
  }
  const visited = new Set();
  const order = [];
  for (const source of forward.keys()) {
    if (visited.has(source)) continue;
    visited.add(source);
    const stack = [[source, 0]];
    while (stack.length) {
      const frame = stack.at(-1);
      const targets = forward.get(frame[0]);
      if (frame[1] < targets.length) {
        const target = targets[frame[1]++];
        if (!visited.has(target)) {
          visited.add(target);
          stack.push([target, 0]);
        }
      } else {
        order.push(frame[0]);
        stack.pop();
      }
    }
  }
  const components = new Map();
  for (const source of order.toReversed()) {
    if (components.has(source)) continue;
    const pending = [source];
    components.set(source, source);
    while (pending.length) {
      for (const target of reverse.get(pending.pop())) {
        if (components.has(target)) continue;
        components.set(target, source);
        pending.push(target);
      }
    }
  }
  return [...forward].flatMap(([from, targets]) =>
    [...new Set(targets)]
      .filter((to) => components.get(from) === components.get(to))
      .map((to) => ({ from, to, rule: { name: "no-circular" } })),
  );
}
