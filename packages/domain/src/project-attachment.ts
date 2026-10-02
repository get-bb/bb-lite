export class ProjectAttachmentError extends Error {}

export function pathLooksRuntimeReadable(path: string): boolean {
  return /^[\\/]|^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path);
}

export function canonicalProjectAttachmentPath(path: string): string {
  if (pathLooksRuntimeReadable(path) || path.includes("\0")) {
    throw new ProjectAttachmentError(
      "Attachment path escapes project directory",
    );
  }
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) {
        throw new ProjectAttachmentError(
          "Attachment path escapes project directory",
        );
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    throw new ProjectAttachmentError(
      "Attachment path must refer to a file inside the project directory",
    );
  }
  if (parts[0] === ".pending")
    throw new ProjectAttachmentError("Attachment path is reserved for uploads");
  return parts.join("/");
}
