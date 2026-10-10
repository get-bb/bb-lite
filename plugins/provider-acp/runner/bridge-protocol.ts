export type {
  AcpNativeReasoning as AcpBridgeNativeReasoning,
  AcpPermissionCli as AcpBridgePermissionCli,
  AcpReasoningCli as AcpBridgeReasoningCli,
} from "../src/launch-spec.js";

export const ACP_DEFAULT_MODEL_ID = "acp-default";

export const ACP_TURN_STARTED_METHOD = "acp/turn/started";
export const ACP_TURN_COMPLETED_METHOD = "acp/turn/completed";
export const ACP_COMPACTION_STARTED_METHOD = "acp/compaction/started";
export const ACP_COMPACTION_COMPLETED_METHOD = "acp/compaction/completed";
export const ACP_UPDATE_METHOD = "acp/update";
export const ACP_FS_WRITE_METHOD = "acp/fs/write";
export const ACP_WARNING_METHOD = "acp/warning";
