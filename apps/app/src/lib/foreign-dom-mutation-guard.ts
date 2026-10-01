const MAX_LOGGED_SUPPRESSIONS = 3;

type RemoveChild = <T extends Node>(child: T) => T;
type InsertBefore = <T extends Node>(node: T, child: Node | null) => T;
type ReplaceChild = <T extends Node>(node: Node, child: T) => T;

let installed = false;
let loggedCount = 0;

function describeNode(node: Node): string {
  if (node instanceof Element) {
    const id = node.id ? `#${node.id}` : "";
    const testId = node.getAttribute("data-testid");
    return `<${node.localName}${id}${testId ? `[data-testid=${testId}]` : ""}>`;
  }
  if (node.nodeType === Node.TEXT_NODE) return "#text";
  return `#node(${node.nodeType})`;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function isHierarchyRequestError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "HierarchyRequestError"
  );
}

function recordSuppression(
  operation: "removeChild" | "insertBefore" | "replaceChild",
  node: Node,
  expectedParent: Node,
): void {
  if (loggedCount >= MAX_LOGGED_SUPPRESSIONS) return;
  loggedCount += 1;
  console.warn(
    `[bb] ${operation}: ${describeNode(node)} is no longer a child of ${describeNode(
      expectedParent,
    )}. Something outside React moved or removed it (a browser extension ` +
      `or page translation is the usual cause); the ` +
      `call was suppressed instead of crashing the app.`,
    { node, expectedParent, actualParent: node.parentNode },
  );
}

export function installForeignDomMutationGuard(): void {
  if (installed || typeof Node !== "function") return;
  installed = true;

  const nativeRemoveChild = Node.prototype.removeChild;
  const nativeInsertBefore = Node.prototype.insertBefore;
  const nativeReplaceChild = Node.prototype.replaceChild;

  const guardedRemoveChild: RemoveChild = function removeChild<T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.parentNode !== this) {
      recordSuppression("removeChild", child, this);
      return child;
    }
    try {
      nativeRemoveChild.call(this, child);
    } catch (error) {
      if (isNotFoundError(error)) {
        recordSuppression("removeChild", child, this);
        return child;
      }
      throw error;
    }
    return child;
  };

  const guardedInsertBefore: InsertBefore = function insertBefore<
    T extends Node,
  >(this: Node, node: T, child: Node | null): T {
    if (child !== null && child.parentNode !== this) {
      recordSuppression("insertBefore", child, this);
      try {
        nativeInsertBefore.call(this, node, null);
      } catch (error) {
        if (!isNotFoundError(error) && !isHierarchyRequestError(error)) {
          throw error;
        }
      }
      return node;
    }
    try {
      nativeInsertBefore.call(this, node, child);
    } catch (error) {
      if (isNotFoundError(error)) {
        recordSuppression("insertBefore", child ?? node, this);
        return node;
      }
      throw error;
    }
    return node;
  };

  const guardedReplaceChild: ReplaceChild = function replaceChild<
    T extends Node,
  >(this: Node, node: Node, child: T): T {
    if (child.parentNode !== this) {
      recordSuppression("replaceChild", child, this);
      if (node.parentNode !== this) {
        try {
          nativeInsertBefore.call(this, node, null);
        } catch (error) {
          if (!isNotFoundError(error) && !isHierarchyRequestError(error)) {
            throw error;
          }
        }
      }
      return child;
    }
    try {
      nativeReplaceChild.call(this, node, child);
    } catch (error) {
      if (isNotFoundError(error)) {
        recordSuppression("replaceChild", child, this);
        return child;
      }
      throw error;
    }
    return child;
  };

  Node.prototype.removeChild = guardedRemoveChild;
  Node.prototype.insertBefore = guardedInsertBefore;
  Node.prototype.replaceChild = guardedReplaceChild;
}
