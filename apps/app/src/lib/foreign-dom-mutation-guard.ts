let warningCount = 0;

function warn(operation: string, node: Node, expectedParent: Node): void {
  if (warningCount >= 3) return;
  warningCount += 1;
  console.warn(
    `[bb] ${operation}: a node is no longer a child of its expected parent. ` +
      `Something outside React moved or removed it (a browser extension ` +
      `or page translation is the usual cause); the call was suppressed ` +
      `instead of crashing the app.`,
    { node, expectedParent, actualParent: node.parentNode },
  );
}

export function installForeignDomMutationGuard(): void {
  const { removeChild, insertBefore, replaceChild } = Node.prototype;
  const append = (parent: Node, node: Node) => {
    try {
      insertBefore.call(parent, node, null);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  };
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T) {
    if (child.parentNode === this) return removeChild.call(this, child) as T;
    warn("removeChild", child, this);
    return child;
  };
  Node.prototype.insertBefore = function <T extends Node>(
    this: Node,
    node: T,
    child: Node | null,
  ) {
    if (child === null || child.parentNode === this) {
      return insertBefore.call(this, node, child) as T;
    }
    warn("insertBefore", child, this);
    append(this, node);
    return node;
  };
  Node.prototype.replaceChild = function <T extends Node>(
    this: Node,
    node: Node,
    child: T,
  ) {
    if (child.parentNode === this) {
      return replaceChild.call(this, node, child) as T;
    }
    warn("replaceChild", child, this);
    if (node.parentNode !== this) append(this, node);
    return child;
  };
}
