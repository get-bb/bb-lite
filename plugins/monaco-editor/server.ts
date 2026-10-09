import { files, type PluginServerApi } from "@bb/plugin";
import { MAX_EDITABLE_BYTES, monacoEditor } from "./contract.js";

export default function monacoEditorServer(bb: PluginServerApi): void {
  bb.implement(monacoEditor.read, async ({ threadId, path }) => {
    const file = await bb.call(files.read, { threadId, path });
    if (file === null) {
      return { kind: "unsupported" as const, reason: "This file is missing" };
    }
    if (file.content.includes("\u0000")) {
      return { kind: "unsupported" as const, reason: "This file is not text" };
    }
    const bytes = Buffer.byteLength(file.content);
    if (bytes > MAX_EDITABLE_BYTES) {
      const megabytes = Math.round(bytes / 1024 / 1024);
      return {
        kind: "unsupported" as const,
        reason: `This file is too large to edit (${megabytes} MB)`,
      };
    }
    return { kind: "text" as const, ...file };
  });
  bb.implement(monacoEditor.write, ({ threadId, path, ...rest }) =>
    bb.call(files.write, { threadId, path, ...rest }),
  );
}
