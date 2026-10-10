import type { MentionProvider } from "@bb/plugin";
import type { Item } from "./contract.js";

type Kind = Item["kind"];

export function createIssueMentions(
  items: () => Promise<Item[]>,
  live: (kind: Kind, repo: string, number: number) => Promise<Item>,
): MentionProvider[] {
  const provider = (kind: Kind, label: string): MentionProvider => ({
    id: kind,
    label,
    triggers: ["@", "#"],
    async search({ query }) {
      const needle = query.trim().toLowerCase();
      return (await items())
        .filter(
          (item) =>
            item.kind === kind &&
            item.state === "open" &&
            `${item.repo}#${item.number} ${item.title}`
              .toLowerCase()
              .includes(needle),
        )
        .slice(0, 8)
        .map((item) => ({
          id: `${item.repo}#${item.number}`,
          title: `#${item.number} ${item.title}`,
          subtitle: item.repo,
        }));
    },
    async resolve(itemId) {
      const match = itemId.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
      if (match === null) throw new Error(`malformed mention id "${itemId}"`);
      const [, repo, digits] = match;
      const number = Number(digits);
      const cached = (await items()).find(
        (item) =>
          item.kind === kind && item.repo === repo && item.number === number,
      );
      const item = await live(kind, repo, number).catch((error: unknown) => {
        if (cached === undefined) throw error;
        return cached;
      });
      const noun = kind === "pr" ? "pull request" : "issue";
      return {
        context: [
          `# GitHub ${noun} ${itemId}: ${item.title}`,
          "",
          `State: ${item.state} · Author: ${item.author}`,
          `URL: ${item.url}`,
          "",
          item.body.length > 0 ? item.body : "(no description)",
          "",
          `For full comments/diff run: gh ${kind} view ${number} -R ${repo} --comments`,
        ].join("\n"),
      };
    },
  });
  return [
    provider("issue", "GitHub issues"),
    provider("pr", "GitHub pull requests"),
  ];
}
