import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type { createTestServer } from "./helpers.js";

export type TestServer = Awaited<ReturnType<typeof createTestServer>>;

const LISTS = ["project", "thread", "host", "environment"] as const;

export async function watchChanges(server: TestServer) {
  const client = await server.socket();
  await client.subscribe({ kind: "system" });
  for (const list of LISTS) await client.subscribe({ kind: `${list}-list` });
  return (entity: string, ...kinds: string[]) =>
    client.next(({ entity: changed, changes }) => {
      const sent = changes as string[];
      return changed === entity && kinds.every((kind) => sent.includes(kind));
    });
}

export function insertThread(
  { ctx }: TestServer,
  id: string,
  projectId: string = PERSONAL_PROJECT_ID,
): void {
  ctx.db.run(
    `INSERT INTO threads
       (id, project_id, provider_id, latest_attention_at, created_at, updated_at)
     VALUES (?, ?, 'echo', 1, 1, 1)`,
    id,
    projectId,
  );
}

export async function createProject(
  { api, ctx }: TestServer,
  name: string,
  path = `/repos/${name}`,
) {
  const { hostId } = ctx.config;
  const source = { type: "local_path" as const, hostId, path };
  return (await api.projects.$post({ json: { name, source } })).json();
}
