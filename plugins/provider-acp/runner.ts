import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { runner, type PluginRunnerApi } from "@bb/runner";
import { acpMachine } from "./contract.js";
import { createAcpAdapter } from "./runner/adapter.js";
import {
  acpProviderUsage,
  closeAcpToolProxy,
  setAcpToolProxyDirectory,
} from "./runner/engine.js";
import { probeAcpAgent } from "./runner/probe.js";
import { runnerAgent } from "./src/agents.js";
import { KNOWN_ACP_AGENTS } from "./src/known-agents.js";
import type { AcpRunnerAgent } from "./src/launch-spec.js";

export default function acpRunner(bb: PluginRunnerApi): void {
  setAcpToolProxyDirectory(bb.dataDir);
  bb.onDispose(closeAcpToolProxy);
  const offered = new Map<string, { agent: AcpRunnerAgent; drop(): void }>();

  const offer = (agents: readonly AcpRunnerAgent[]) => {
    const wanted = new Map(agents.map((agent) => [agent.id, agent]));
    for (const [id, { agent, drop }] of offered) {
      if (isDeepStrictEqual(wanted.get(id), agent)) continue;
      drop();
      offered.delete(id);
    }
    for (const agent of wanted.values()) {
      if (offered.has(agent.id)) continue;
      const drop = bb.add(runner.provider, createAcpAdapter(agent));
      offered.set(agent.id, { agent, drop });
    }
    return { providerIds: [...offered.keys()] };
  };

  offer(KNOWN_ACP_AGENTS.map(runnerAgent));
  bb.implement(acpMachine.configure, ({ agents }) => offer(agents));
  bb.implement(acpMachine.probe, ({ command, args, env }) =>
    probeAcpAgent({ command, args, env, cwd: tmpdir() }),
  );
  bb.implement(acpMachine.usage, async ({ providerId }) => {
    const agent = offered.get(providerId)?.agent;
    if (agent === undefined) return null;
    const options = {
      acpLaunchSpec: agent.launch,
      ...(agent.dialect === undefined ? {} : { acpDialect: agent.dialect }),
    };
    return acpProviderUsage(options);
  });
}
