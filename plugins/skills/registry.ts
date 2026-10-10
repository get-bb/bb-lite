import { z } from "zod";
import type { RegistrySkill, SkillSource } from "./contract.js";

const TIMEOUT_MS = 10_000;
const LIMIT = 50;

const pageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string().optional(),
      source: z.string(),
      installs: z.number().optional(),
      url: z.string().optional(),
      summary: z.string().nullish(),
    }),
  ),
});

function address(base: string, query: string) {
  const url = new URL(
    query === "" ? "/api/v1/skills" : "/api/v1/skills/search",
    base,
  );
  if (query === "") url.searchParams.set("view", "trending");
  else url.searchParams.set("q", query);
  url.searchParams.set(query === "" ? "per_page" : "limit", String(LIMIT));
  return url;
}

export function registrySource(
  settings: () => Promise<{ registryUrl: string }>,
): SkillSource {
  return {
    id: "registry",
    label: "Skills registry",
    async search(query, signal) {
      const { registryUrl } = await settings();
      if (registryUrl.trim() === "") return [];
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetch(address(registryUrl, query.trim()), {
        signal: AbortSignal.any([signal, timeout]),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`registry ${response.status}`);
      const page = pageSchema.parse(await response.json());
      return page.data.map((entry): RegistrySkill => ({
        id: entry.id,
        name: entry.name,
        description: entry.summary ?? null,
        install: `https://github.com/${entry.source}.git`,
        skill: entry.slug ?? entry.name,
        ...(entry.url === undefined ? {} : { url: entry.url }),
        ...(entry.installs === undefined ? {} : { installs: entry.installs }),
      }));
    },
  };
}
