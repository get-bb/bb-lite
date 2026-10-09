import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";

const SAME = (c: string, names: string) =>
  Object.fromEntries(names.split(" ").map((n) => [`${c}.${n}`, `${c}.${n}`]));
const MAP: Record<string, string> = {
  ...SAME("environments", "delete diffBranches diffFile diffFiles diffPatch get list paths status update archiveThreads"),
  "environments.listProviders": "environments.providers!",
  "environments.commit": "environments.runAction!",
  "files.read": "machines.readFile",
  "files.write": "machines.writeFile",
  "files.list": "machines.listFiles",
  "hosts.delete": "machines.delete",
  "hosts.directory": "machines.directory",
  "hosts.get": "machines.get",
  "hosts.list": "machines.list",
  "hosts.open": "machines.open",
  "hosts.openTargets": "machines.openTargets",
  "hosts.pathsExist": "machines.pathsExist",
  "hosts.update": "machines.update",
  "hosts.setSharing": "machines.updateSharing",
  "hosts.experimental_getEnrollmentCommand": "machines.enrollmentCommand",
  "hosts.experimental_reconnect": "machines.createReconnectCommand",
  "hosts.experimental_create": "machines.create!",
  ...SAME("projects", "branches commands create defaultExecutionOptions delete get list machineEnvironment paths promptHistory update"),
  "projects.attachments.copy": "projects.copyAttachments",
  "projects.replaceMachineEnvironment": "projects.updateMachineEnvironment",
  "projects.sources.add": "projects.createSource!",
  "projects.sources.delete": "projects.deleteSource",
  "projects.sources.update": "projects.updateSource",
  "providers.catalog": "sessions.providerCatalog",
  "providers.list": "sessions.providers",
  "providers.models": "sessions.executionOptions",
  "providers.setEnabled": "sessions.updateProvider",
  "system.config": "server.config",
  "system.executionOptions": "sessions.executionOptions",
  "system.machineEnvironment": "settings.machineEnvironment",
  "system.replaceMachineEnvironment": "settings.updateMachineEnvironment",
  "system.uiPreferences.list": "settings.uiPreferences",
  "system.uiPreferences.set": "settings.updateUiPreference",
  "system.uiPreferences.reset": "settings.resetUiPreference",
  "system.updateGeneralSettings": "settings.updateGeneral!",
  "system.updateKeyboardSettings": "settings.updateKeyboard!",
  "terminals.close": "terminals.close!",
  "terminals.create": "terminals.create!",
  "terminals.input": "terminals.write",
  "terminals.list": "terminals.list!",
  "terminals.output": "terminals.output",
  "terminals.rename": "terminals.update",
  "terminals.get": "terminals.get",
  "theme.set": "settings.updateAppearance!",
  ...SAME("threads", "archive childSummary defaultExecutionOptions delete get list markRead markUnread open output pin promptHistory resolveMentions search send stop timeline timelineTurnSummaryDetails unarchive unpin update compact clearContext reorderPinned"),
  "threads.archiveAll": "threads.archive",
  "threads.events.list": "threads.events!",
  "threads.interactions.cancel": "interactions.cancel",
  "threads.interactions.get": "interactions.get",
  "threads.interactions.list": "interactions.list",
  "threads.interactions.resolve": "interactions.resolve",
  "threads.interactions.respond": "interactions.respond",
  "threads.queuedMessages.create": "threads.createQueuedMessage",
  "threads.queuedMessages.delete": "threads.deleteQueuedMessage",
  "threads.queuedMessages.list": "threads.listQueuedMessages",
  "threads.queuedMessages.send": "threads.sendQueuedMessage",
  "threads.queuedMessages.update": "threads.updateQueuedMessage",
  "threads.spawn": "threads.create!",
  "threads.tabs.get": "threads.tabs!",
  "threads.tabs.update": "threads.updateTabs!",
  "threadSections.create": "sections.create",
  "threadSections.delete": "sections.delete",
  "threadSections.list": "sections.list",
  "threadSections.update": "sections.update",
  ...SAME("users", "createInvite createSignInLink list setPassword update presence"),
  "users.invites": "users.listInvites",
  "plugins.contributions": "plugins.contributions",
  "plugins.list": "plugins.list",
  "plugins.getSettings": "plugins.settings",
  "plugins.updateSettings": "plugins.updateSettings",
  "plugins.enable": "plugins.enable",
  "plugins.disable": "plugins.disable",
  "plugins.reload": "plugins.reload!",
  "users.revokeInvite": "users.deleteInvite",
};

const mode = process.argv[2] as "app" | "cli";
const report: string[] = [];
for (const file of process.argv.slice(3)) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits: { start: number; end: number; text: string }[] = [];
  const used = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const names: string[] = [];
      let cursor: ts.Expression = node.expression;
      let receiver: ts.Expression | null = null;
      while (ts.isPropertyAccessExpression(cursor)) {
        if (cursor.name.text === "sdk") { receiver = cursor.expression; break; }
        names.unshift(cursor.name.text);
        cursor = cursor.expression;
      }
      const bare = ts.isIdentifier(cursor) && cursor.text === "sdk";
      if ((receiver !== null || bare) && names.length >= 2) {
        const key = names.join(".");
        const target = MAP[key];
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (target === undefined) {
          report.push(`${file}:${line} UNMAPPED sdk.${key}`);
        } else {
          const manual = target.endsWith("!");
          const op = manual ? target.slice(0, -1) : target;
          const [contract] = op.split(".");
          used.add(contract!);
          const prefix = receiver === null ? "" : `${receiver.getText()}.`;
          const callee = mode === "cli" ? `${prefix}call(${prefix}ops.${op}` : `callOp(${op}`;
          const [arg] = node.arguments;
          let input = "{}";
          let options = "";
          if (arg !== undefined) {
            input = arg.getText();
            if (ts.isObjectLiteralExpression(arg)) {
              const signal = arg.properties.find((p) => p.name !== undefined && p.name.getText() === "signal");
              if (signal !== undefined) {
                const rest = arg.properties.filter((p) => p !== signal).map((p) => p.getText());
                input = rest.length === 0 ? "{}" : `{ ${rest.join(", ")} }`;
                const value = ts.isPropertyAssignment(signal) ? signal.initializer.getText() : "signal";
                options = value === "signal" ? ", { signal }" : `, { signal: ${value} }`;
              }
            } else {
              report.push(`${file}:${line} REVIEW-ARG ${op} <- ${input.slice(0, 40)}`);
            }
          }
          if (manual) report.push(`${file}:${line} MANUAL sdk.${key} -> ${op}`);
          edits.push({ start: node.getStart(), end: node.getEnd(), text: `${callee}, ${input}${options})` });
          for (const inner of node.arguments) ts.forEachChild(inner, visit);
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (edits.length === 0) continue;
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  let last = Infinity;
  for (const edit of edits) {
    if (edit.end > last) { report.push(`${file} NESTED edit skipped at ${edit.start}`); continue; }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    last = edit.start;
  }
  if (mode === "app") {
    const names = [...used].sort().join(", ");
    out = `import { callOp, ${names} } from "@bb/plugin/app";\n${out}`;
  }
  writeFileSync(file, out);
  report.push(`${file} EDITED ${edits.length} [${[...used].join(",")}]`);
}
console.log(report.join("\n"));
