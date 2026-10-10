import {
  explainMember,
  plugins,
  sessions,
  type ContractMember,
  type PluginServerApi,
} from "@bb/plugin";
import * as appExports from "@bb/plugin/app";
import { pluginApi } from "./contract.js";
import {
  memberFacts,
  memberShapes,
  mergeContracts,
  sidesLabel,
  USES,
  type Contract,
  type Described,
  type Member,
  type Uses,
} from "./reference.js";

const KINDS = new Set(["op", "event", "slot", "live"]);

function isMember(value: unknown): value is ContractMember {
  if (typeof value !== "object" || value === null) return false;
  const { type, name } = value as { type?: unknown; name?: unknown };
  return (
    typeof type === "string" && KINDS.has(type) && typeof name === "string"
  );
}

function staticAppContracts(): Described["contracts"] {
  const found = new Map<string, Described["contracts"][number]>();
  for (const value of Object.values(appExports)) {
    if (typeof value !== "object" || value === null) continue;
    const members = Object.entries(value);
    if (members.length === 0 || !members.every(([, m]) => isMember(m))) {
      continue;
    }
    for (const [key, member] of members) {
      if (!isMember(member)) continue;
      const id = member.name.slice(0, member.name.length - key.length - 1);
      const group = found.get(id) ?? { id, plugin: "core", members: {} };
      group.members[key] = explainMember(member) as Record<string, unknown>;
      found.set(id, group);
    }
  }
  return [...found.values()];
}

const STATIC_APP = staticAppContracts();

function memberMarkdown(member: Member, plugin: string): string {
  const facts = memberFacts(member, plugin).map(
    ({ label, value }) => `- ${label}: ${value}`,
  );
  const shapes = memberShapes(member).map(
    ({ label, shape }) =>
      `${label}:\n\n\`\`\`json\n${JSON.stringify(shape, null, 2)}\n\`\`\``,
  );
  return [
    `### ${member.name} (${member.type})`,
    facts.join("\n"),
    ...shapes,
  ].join("\n\n");
}

const APP_NOTE =
  "App contracts live in the app kernel; this lists them from @bb/plugin/app. Which plugins fill them is shown on the Plugin Guide page.";

function contractMarkdown(group: Contract): string {
  const body = group.members.map((member) =>
    memberMarkdown(member, group.plugin),
  );
  const side = `Side: ${sidesLabel(group.sides)}. Declared by ${group.plugin}.`;
  const note = group.sides.includes("server") ? [] : [APP_NOTE];
  return [`## ${group.id}`, side, ...note, ...body].join("\n\n");
}

export function referenceMarkdown(
  api: string,
  contracts: Contract[],
  query: string | undefined,
): string {
  if (query === undefined || query.trim() === "") {
    const rows = contracts.map(({ id, members, sides }) => {
      const side = sides.includes("server") ? "" : ", app only";
      return `- ${id} (${members.length}${side})`;
    });
    return [`Plugin API ${api}`, "Contracts:", rows.join("\n"), APP_NOTE].join(
      "\n\n",
    );
  }
  const word = query.trim().toLowerCase();
  const group = contracts.find(({ id }) => id.toLowerCase() === word);
  if (group !== undefined) return contractMarkdown(group);
  const all = contracts.flatMap(({ plugin, members }) =>
    members.map((member) => ({ plugin, member })),
  );
  const exact = all.find(({ member }) => member.name.toLowerCase() === word);
  if (exact !== undefined) return memberMarkdown(exact.member, exact.plugin);
  const matches = all.filter(({ member }) =>
    member.name.toLowerCase().includes(word),
  );
  const [only] = matches;
  if (only === undefined)
    return `Nothing in the plugin API matches "${query}".`;
  if (matches.length === 1) return memberMarkdown(only.member, only.plugin);
  const rows = matches.map(({ member }) => `- ${member.name} (${member.type})`);
  return [`Matches for "${query}":`, rows.join("\n")].join("\n\n");
}

export function usesMarkdown(id: string, uses: Uses): string {
  const rows = USES.map(([key, label]) => {
    const values = uses[key];
    return `- ${label}: ${values.length === 0 ? "nothing" : values.join(", ")}`;
  });
  return [
    `## Plugin ${id}`,
    rows.join("\n"),
    "App-side slots it fills are shown on the Plugin Guide page.",
  ].join("\n\n");
}

export default function pluginApiDocs(bb: PluginServerApi): void {
  const reference = async () => {
    const server = await bb.call(plugins.contracts, {});
    const known = new Set(server.contracts.map(({ id }) => id));
    const app = STATIC_APP.filter(({ id }) => !known.has(id));
    const contracts = mergeContracts([
      { side: "server", described: server },
      {
        side: "app",
        described: { api: server.api, contracts: app },
        stateless: true,
      },
    ]);
    return { api: server.api, contracts };
  };
  bb.implement(pluginApi.get, async ({ name, plugin }) => {
    if (plugin !== undefined) {
      const found = await bb.call(plugins.describe, { id: plugin });
      if (found?.uses === undefined) return `No plugin "${plugin}" is loaded.`;
      return usesMarkdown(plugin, found.uses);
    }
    const { api, contracts } = await reference();
    return referenceMarkdown(api, contracts, name);
  });
  bb.add(sessions.mention, {
    id: "plugin-api",
    label: "Plugin API",
    async search({ query }) {
      const word = query.toLowerCase();
      const { contracts } = await reference();
      return contracts
        .flatMap(({ members }) => members)
        .filter(({ name }) => name.toLowerCase().includes(word))
        .slice(0, 20)
        .map(({ name, type }) => ({ id: name, title: name, subtitle: type }));
    },
    async resolve(itemId) {
      const { api, contracts } = await reference();
      return { context: referenceMarkdown(api, contracts, itemId) };
    },
  });
}
