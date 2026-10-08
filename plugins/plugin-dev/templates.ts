export function templates(id: string): Record<string, string> {
  const title = id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const constant = id.replace(/-(\w)/gu, (_dash, letter: string) =>
    letter.toUpperCase(),
  );
  const manifest = {
    name: `bb-plugin-${id}`,
    version: "0.1.0",
    private: true,
    type: "module",
    description: `${title}: a bb plugin.`,
    bb: {
      name: title,
      description: `${title}: a bb plugin.`,
      icon: "Plug02",
      server: "./server.ts",
      app: "./app.tsx",
    },
    keywords: ["bb-plugin"],
  };
  const tsconfig = {
    extends: "./.bb/tsconfig.json",
    include: ["*.ts", "*.tsx"],
  };
  return {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify(tsconfig, null, 2)}\n`,
    "contract.ts": `import { contract, live, op } from "@bb/plugin";
import { z } from "zod";

export const ${constant} = contract("${id}", {
  greet: op({
    input: z.object({ name: z.string().describe("Who to greet") }),
    output: z.string(),
    kind: "write",
    doors: {
      cli: {
        path: "${id} greet",
        summary: "Greet someone",
        positionals: ["name"],
      },
      agent: {
        name: "${title.replaceAll(" ", "")}Greet",
        description: "Greet someone by name.",
      },
    },
  }),
  greetings: live(z.number()),
});
`,
    "server.ts": `import type { PluginServerApi } from "@bb/plugin";
import { ${constant} } from "./contract.js";

export default function plugin(bb: PluginServerApi): void {
  const greetings = bb.provide(${constant}.greetings, 0);

  bb.implement(${constant}.greet, ({ name }, { caller }) => {
    greetings.update((count) => count + 1);
    const through = caller.door === "agent" ? " (asked by an agent)" : "";
    return \`Hello, \${name}!\${through}\`;
  });
}
`,
    "app.tsx": `import { useState } from "react";
import { plugin, useCall, useLive } from "@bb/plugin/app";
import { ${constant} } from "./contract";

function Panel() {
  const greet = useCall(${constant}.greet);
  const greetings = useLive(${constant}.greetings) ?? 0;
  const [reply, setReply] = useState("");
  return (
    <div style={{ padding: 24 }}>
      <button onClick={() => void greet({ name: "bb" }).then(setReply)}>
        Greet
      </button>
      <p>{reply}</p>
      <p>Greetings so far: {greetings}</p>
    </div>
  );
}

export default plugin((bb) => {
  bb.slots.navPanel({
    id: "${id}",
    title: "${title}",
    icon: "Plug02",
    path: "${id}",
    component: Panel,
  });
});
`,
  };
}
