import * as NodePath from "node:path";

export function isPathWithin(root: string, target: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(target));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

export function assertPathOutside(root: string, target: string, error: string): void {
  if (NodePath.resolve(root) === NodePath.resolve(target) || isPathWithin(root, target))
    throw new Error(error);
}

export function relativePathWithin(root: string, target: string, error: string): string {
  if (!isPathWithin(root, target)) throw new Error(error);
  return NodePath.relative(NodePath.resolve(root), NodePath.resolve(target));
}
