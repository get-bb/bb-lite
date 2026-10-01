import type {
  DynamicTool,
  PendingInteraction,
  ToolCallResponse,
} from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";

export interface ThreadExtensionContext {
  threadId: string;
  projectId: string;
  providerId: string;
  environmentId: string;
  hostId: string;
  model: string;
}

export interface ToolCallContext extends ThreadExtensionContext {
  callId: string;
  signal: AbortSignal;
}

export interface InstructionContribution {
  pluginId: string;
  text: string;
  dynamic: boolean;
}

export interface AgentToolContribution {
  pluginId: string;
  tool: DynamicTool;
  instructions: string | null;
}

interface ThreadEvent {
  thread: ThreadResponse;
}

export interface ExtensionEvents {
  "thread.created": ThreadEvent;
  "thread.active": ThreadEvent;
  "thread.idle": ThreadEvent & { lastAssistantText: string | null };
  "thread.failed": ThreadEvent & { error: string | null };
  "thread.archived": ThreadEvent;
  "thread.unarchived": ThreadEvent;
  "thread.deleted": ThreadEvent;
  "interaction.pending": ThreadEvent & { interaction: PendingInteraction };
}

type Scoped<Result> = (thread: ThreadExtensionContext) => Promise<Result>;

export interface Extensions {
  instructions: Scoped<InstructionContribution[]>;
  agentTools: Scoped<AgentToolContribution[]>;
  contributedEnv: Scoped<Record<string, string>>;
  callAgentTool(
    name: string,
    args: unknown,
    call: ToolCallContext,
  ): Promise<ToolCallResponse | null>;
  emit<Name extends keyof ExtensionEvents>(
    name: Name,
    payload: ExtensionEvents[Name],
  ): void;
  generateTitle(prompt: string): Promise<string | null>;
}

export function createNoExtensions(): Extensions {
  return {
    instructions: async () => [],
    agentTools: async () => [],
    callAgentTool: async () => null,
    contributedEnv: async () => ({}),
    emit: () => {},
    generateTitle: async () => null,
  };
}
