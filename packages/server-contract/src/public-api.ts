import * as api from "./api-types.js";
import * as domain from "@bb/domain";
import type { Hono } from "hono";
import {
  binaryResponse,
  defineRoute,
  formRequest,
  jsonRequest,
  jsonResponse,
  noRequest,
  optionalQueryRequest,
  queryRequest,
  type ApiSchemaFromRouteDescriptors,
  type EmptyInput,
} from "@bb/hono-typed-routes";

type Path<Keys extends string> = { param: Record<Keys, string> };

export const publicApiRoutes = {
  projects: {
    machineEnvironment: defineRoute({
      path: "/projects/:id/machine-environment",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ProjectMachineEnvironmentList>(),
    }),
    replaceMachineEnvironment: defineRoute({
      path: "/projects/:id/machine-environment",
      method: "put",
      request: jsonRequest<Path<"id">, api.MachineEnvironmentReplace>(
        api.machineEnvironmentReplaceSchema,
      ),
      response: jsonResponse<api.ProjectMachineEnvironmentList>(),
    }),

    list: defineRoute({
      path: "/projects",
      method: "get",
      request: optionalQueryRequest<EmptyInput, api.ProjectListQuery>(
        api.projectListQuerySchema,
      ),
      response: jsonResponse<
        api.ProjectResponse[] | api.ProjectWithThreadsResponse[]
      >(),
    }),
    create: defineRoute({
      path: "/projects",
      method: "post",
      request: jsonRequest<EmptyInput, api.CreateProjectRequest>(
        api.createProjectRequestSchema,
      ),
      response: jsonResponse<api.ProjectResponse>({ status: 201 }),
    }),
    sidebarBootstrap: defineRoute({
      path: "/sidebar-bootstrap",
      method: "get",
      request: noRequest(),
      response: jsonResponse<api.SidebarBootstrapResponse>(),
    }),
    get: defineRoute({
      path: "/projects/:id",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ProjectResponse>(),
    }),
    update: defineRoute({
      path: "/projects/:id",
      method: "patch",
      request: jsonRequest<Path<"id">, api.UpdateProjectRequest>(
        api.updateProjectRequestSchema,
      ),
      response: jsonResponse<api.ProjectResponse>(),
    }),
    delete: defineRoute({
      path: "/projects/:id",
      method: "delete",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    defaultExecutionOptions: defineRoute({
      path: "/projects/:id/default-execution-options",
      method: "get",
      request: queryRequest<
        Path<"id">,
        api.ProjectDefaultExecutionOptionsQuery
      >(api.projectDefaultExecutionOptionsQuerySchema),
      response: jsonResponse<domain.ProjectExecutionDefaults | null>(),
    }),
    promptHistory: defineRoute({
      path: "/projects/:id/prompt-history",
      method: "get",
      request: optionalQueryRequest<Path<"id">, api.PromptHistoryQuery>(
        api.promptHistoryQuerySchema,
      ),
      response: jsonResponse<api.PromptHistoryResponse>(),
    }),
    createSource: defineRoute({
      path: "/projects/:id/sources",
      method: "post",
      request: jsonRequest<Path<"id">, api.CreateProjectSourceRequest>(
        api.createProjectSourceRequestSchema,
      ),
      response: jsonResponse<domain.ProjectSource>({ status: 201 }),
    }),
    updateSource: defineRoute({
      path: "/projects/:id/sources/:sourceId",
      method: "patch",
      request: jsonRequest<
        Path<"id" | "sourceId">,
        api.UpdateProjectSourceRequest
      >(api.updateProjectSourceRequestSchema),
      response: jsonResponse<domain.ProjectSource>(),
    }),
    deleteSource: defineRoute({
      path: "/projects/:id/sources/:sourceId",
      method: "delete",
      request: noRequest<Path<"id" | "sourceId">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    paths: defineRoute({
      path: "/projects/:id/paths",
      method: "get",
      request: queryRequest<Path<"id">, api.ProjectPathsQuery>(
        api.projectPathsQuerySchema,
      ),
      response: jsonResponse<api.WorkspacePathListResponse>(),
    }),
    commands: defineRoute({
      path: "/projects/:id/commands",
      method: "get",
      request: queryRequest<Path<"id">, api.ProjectCommandsQuery>(
        api.projectCommandsQuerySchema,
      ),
      response: jsonResponse<api.CommandListResponse>(),
    }),
    branches: defineRoute({
      path: "/projects/:id/branches",
      method: "get",
      request: queryRequest<Path<"id">, api.ProjectBranchesQuery>(
        api.projectBranchesQuerySchema,
      ),
      response: jsonResponse<api.ProjectBranchesResponse>(),
    }),
    branchOptions: defineRoute({
      path: "/projects/:id/branch-options",
      method: "get",
      request: queryRequest<Path<"id">, api.ProjectBranchesQuery>(
        api.projectBranchesQuerySchema,
      ),
      response: jsonResponse<api.ProjectBranchesResponse>(),
    }),
    uploadAttachment: defineRoute({
      path: "/projects/:id/attachments",
      method: "post",
      request: formRequest<Path<"id">, api.ProjectAttachmentUploadForm>(),
      response: jsonResponse<api.UploadedPromptAttachment>({ status: 201 }),
    }),
    copyAttachments: defineRoute({
      path: "/projects/:id/attachments/copy",
      method: "post",
      request: jsonRequest<Path<"id">, api.CopyProjectAttachmentsRequest>(
        api.copyProjectAttachmentsRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    attachmentContent: defineRoute({
      path: "/projects/:id/attachments/content",
      method: "get",
      request: queryRequest<Path<"id">, api.ProjectAttachmentContentQuery>(
        api.projectAttachmentContentQuerySchema,
      ),
      response: binaryResponse<Uint8Array>(),
    }),
  },

  files: {
    read: defineRoute({
      path: "/files/read",
      method: "post",
      request: jsonRequest<EmptyInput, api.HostFileReadRequest>(
        api.hostFileReadRequestSchema,
      ),
      response: jsonResponse<api.HostFileReadResponse>(),
    }),
    write: defineRoute({
      path: "/files/write",
      method: "post",
      request: jsonRequest<EmptyInput, api.HostFileWriteRequest>(
        api.hostFileWriteRequestSchema,
      ),
      response: jsonResponse<api.HostFileWriteResponse>(),
    }),
    list: defineRoute({
      path: "/files/list",
      method: "post",
      request: jsonRequest<EmptyInput, api.HostFileListRequest>(
        api.hostFileListRequestSchema,
      ),
      response: jsonResponse<api.HostFileListResponse>(),
    }),
  },

  hosts: {
    create: defineRoute({
      path: "/hosts",
      method: "post",
      request: jsonRequest<EmptyInput, api.CreateMachineRequest>(
        api.createMachineRequestSchema,
      ),
      response: jsonResponse<domain.Host>({ status: 201 }),
    }),
    list: defineRoute({
      path: "/hosts",
      method: "get",
      request: optionalQueryRequest<EmptyInput, api.HostListQuery>(
        api.hostListQuerySchema,
      ),
      response: jsonResponse<domain.Host[]>(),
    }),
    get: defineRoute({
      path: "/hosts/:id",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<
        domain.Host & {
          connectMachineId: string | null;
          threadStorageRootPath: string | null;
        }
      >(),
    }),
    enrollmentCommand: defineRoute({
      path: "/hosts/:id/enrollment-command",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.HostEnrollmentCommandResponse>(),
    }),
    reconnect: defineRoute({
      path: "/hosts/:id/reconnect-commands",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.HostReconnectResponse>({ status: 201 }),
    }),
    update: defineRoute({
      path: "/hosts/:id",
      method: "patch",
      request: jsonRequest<Path<"id">, api.UpdateHostRequest>(
        api.updateHostRequestSchema,
      ),
      response: jsonResponse<domain.Host>(),
    }),
    updatePermissionCeiling: defineRoute({
      path: "/hosts/:id/permission-ceiling",
      method: "patch",
      request: jsonRequest<Path<"id">, api.UpdateHostPermissionCeilingRequest>(
        api.updateHostPermissionCeilingRequestSchema,
      ),
      response: jsonResponse<domain.Host>(),
    }),
    delete: defineRoute({
      path: "/hosts/:id",
      method: "delete",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    directory: defineRoute({
      path: "/hosts/:id/directory",
      method: "get",
      request: queryRequest<Path<"id">, api.HostDirectoryQuery>(
        api.hostDirectoryQuerySchema,
      ),
      response: jsonResponse<api.HostDirectoryListing>(),
    }),
    pathsExist: defineRoute({
      path: "/hosts/:id/paths/exist",
      method: "post",
      request: jsonRequest<Path<"id">, api.HostPathsExistRequest>(
        api.hostPathsExistRequestSchema,
      ),
      response: jsonResponse<api.HostPathsExistResponse>(),
    }),
    openTargets: defineRoute({
      path: "/hosts/:id/open-targets",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.HostOpenTargetsResponse>(),
    }),
    open: defineRoute({
      path: "/hosts/:id/open",
      method: "post",
      request: jsonRequest<Path<"id">, api.HostOpenRequest>(
        api.hostOpenRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
  },

  terminals: {
    list: defineRoute({
      path: "/terminals",
      method: "get",
      request: queryRequest<EmptyInput, api.TerminalListQuery>(
        api.terminalListQuerySchema,
      ),
      response: jsonResponse<api.TerminalListResponse>(),
    }),
    create: defineRoute({
      path: "/terminals",
      method: "post",
      request: jsonRequest<EmptyInput, api.CreateTerminalRequest>(
        api.createTerminalRequestSchema,
      ),
      response: jsonResponse<api.TerminalSession>({ status: 201 }),
    }),
    get: defineRoute({
      path: "/terminals/:terminalId",
      method: "get",
      request: noRequest<Path<"terminalId">>(),
      response: jsonResponse<api.TerminalSession>(),
    }),
    update: defineRoute({
      path: "/terminals/:terminalId",
      method: "patch",
      request: jsonRequest<Path<"terminalId">, api.UpdateTerminalRequest>(
        api.updateTerminalRequestSchema,
      ),
      response: jsonResponse<api.TerminalSession>(),
    }),
    close: defineRoute({
      path: "/terminals/:terminalId/close",
      method: "post",
      request: jsonRequest<Path<"terminalId">, api.CloseTerminalRequest>(
        api.closeTerminalRequestSchema,
      ),
      response: jsonResponse<api.TerminalSession>(),
    }),
    input: defineRoute({
      path: "/terminals/:terminalId/input",
      method: "post",
      request: jsonRequest<Path<"terminalId">, api.TerminalInputRequest>(
        api.terminalInputRequestSchema,
      ),
      response: jsonResponse<api.TerminalSession>(),
    }),
    output: defineRoute({
      path: "/terminals/:terminalId/output",
      method: "get",
      request: optionalQueryRequest<
        Path<"terminalId">,
        api.TerminalOutputQuery
      >(api.terminalOutputQuerySchema),
      response: jsonResponse<api.TerminalOutputResponse>(),
    }),
  },

  environments: {
    list: defineRoute({
      path: "/environments",
      method: "get",
      request: optionalQueryRequest<EmptyInput, api.ListEnvironmentsQuery>(
        api.listEnvironmentsQuerySchema,
      ),
      response: jsonResponse<domain.Environment[]>(),
    }),
    delete: defineRoute({
      path: "/environments/:id",
      method: "delete",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    get: defineRoute({
      path: "/environments/:id",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<domain.Environment>(),
    }),
    update: defineRoute({
      path: "/environments/:id",
      method: "patch",
      request: jsonRequest<Path<"id">, api.UpdateEnvironmentRequest>(
        api.updateEnvironmentRequestSchema,
      ),
      response: jsonResponse<domain.Environment>(),
    }),
    status: defineRoute({
      path: "/environments/:id/status",
      method: "get",
      request: queryRequest<Path<"id">, api.EnvironmentStatusQuery>(
        api.environmentStatusQuerySchema,
      ),
      response: jsonResponse<api.EnvironmentStatusResponse>(),
    }),
    diffFiles: defineRoute({
      path: "/environments/:id/diff/files",
      method: "get",
      request: queryRequest<Path<"id">, api.EnvironmentDiffQuery>(
        api.environmentDiffQuerySchema,
      ),
      response: jsonResponse<api.EnvironmentDiffFilesResponse>(),
    }),
    diffPatch: defineRoute({
      path: "/environments/:id/diff/patch",
      method: "post",
      request: jsonRequest<Path<"id">, api.EnvironmentDiffPatchRequest>(
        api.environmentDiffPatchRequestSchema,
      ),
      response: jsonResponse<api.EnvironmentDiffPatchResponse>(),
    }),
    diffFile: defineRoute({
      path: "/environments/:id/diff/file",
      method: "get",
      request: queryRequest<Path<"id">, api.EnvironmentDiffFileQuery>(
        api.environmentDiffFileQuerySchema,
      ),
      response: jsonResponse<api.EnvironmentDiffFileResponse>(),
    }),
    diffBranches: defineRoute({
      path: "/environments/:id/diff/branches",
      method: "get",
      request: queryRequest<Path<"id">, api.EnvironmentDiffBranchesQuery>(
        api.environmentDiffBranchesQuerySchema,
      ),
      response: jsonResponse<api.EnvironmentDiffBranchesResponse>(),
    }),
    paths: defineRoute({
      path: "/environments/:id/paths",
      method: "get",
      request: queryRequest<Path<"id">, api.EnvironmentPathsQuery>(
        api.environmentPathsQuerySchema,
      ),
      response: jsonResponse<api.WorkspacePathListResponse>(),
    }),
    file: defineRoute({
      path: "/environments/:id/files/:filePath{.+}",
      method: "get",
      request: noRequest<Path<"id" | "filePath">>(),
      response: binaryResponse<Uint8Array>(),
    }),
    revisionFile: defineRoute({
      path: "/environments/:id/revisions/:ref/files/:filePath{.+}",
      method: "get",
      request: noRequest<Path<"id" | "ref" | "filePath">>(),
      response: binaryResponse<Uint8Array>(),
    }),
    actions: defineRoute({
      path: "/environments/:id/actions",
      method: "post",
      request: jsonRequest<Path<"id">, api.EnvironmentActionRequest>(
        api.environmentActionRequestSchema,
      ),
      response: jsonResponse<api.EnvironmentActionResponse>(),
    }),
    archiveThreads: defineRoute({
      path: "/environments/:id/archive-threads",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.EnvironmentArchiveThreadsResponse>(),
    }),
  },

  threadSections: {
    list: defineRoute({
      path: "/thread-sections",
      method: "get",
      request: noRequest<EmptyInput>(),
      response: jsonResponse<api.ThreadSectionResponse[]>(),
    }),
    create: defineRoute({
      path: "/thread-sections",
      method: "post",
      request: jsonRequest<EmptyInput, api.CreateThreadSectionRequest>(
        api.createThreadSectionRequestSchema,
      ),
      response: jsonResponse<api.ThreadSectionResponse>({ status: 201 }),
    }),
    update: defineRoute({
      path: "/thread-sections",
      method: "patch",
      request: jsonRequest<EmptyInput, api.UpdateThreadSectionRequest>(
        api.updateThreadSectionRequestSchema,
      ),
      response: jsonResponse<api.ThreadSectionMutationResponse>(),
    }),
    delete: defineRoute({
      path: "/thread-sections",
      method: "delete",
      request: jsonRequest<EmptyInput, api.DeleteThreadSectionRequest>(
        api.deleteThreadSectionRequestSchema,
      ),
      response: jsonResponse<api.ThreadSectionMutationResponse>(),
    }),
  },

  threads: {
    list: defineRoute({
      path: "/threads",
      method: "get",
      request: optionalQueryRequest<EmptyInput, api.ThreadListQuery>(
        api.threadListQuerySchema,
      ),
      response: jsonResponse<api.ThreadListResponse>(),
    }),
    search: defineRoute({
      path: "/threads/search",
      method: "get",
      request: queryRequest<EmptyInput, api.ThreadSearchQuery>(
        api.threadSearchQuerySchema,
      ),
      response: jsonResponse<api.ThreadSearchResponse>(),
    }),
    resolveMentions: defineRoute({
      path: "/threads/resolve-mentions",
      method: "post",
      request: jsonRequest<EmptyInput, api.ResolveThreadMentionsRequest>(
        api.resolveThreadMentionsRequestSchema,
      ),
      response: jsonResponse<api.ResolveThreadMentionsResponse>(),
    }),
    create: defineRoute({
      path: "/threads",
      method: "post",
      request: jsonRequest<EmptyInput, api.CreateThreadRequest>(
        api.createThreadRequestSchema,
      ),
      response: jsonResponse<api.ThreadResponse>({ status: 201 }),
    }),
    get: defineRoute({
      path: "/threads/:id",
      method: "get",
      request: optionalQueryRequest<Path<"id">, api.ThreadGetQuery>(
        api.threadGetQuerySchema,
      ),
      response: jsonResponse<
        api.ThreadResponse | api.ThreadWithIncludesResponse
      >(),
    }),
    update: defineRoute({
      path: "/threads/:id",
      method: "patch",
      request: jsonRequest<Path<"id">, api.UpdateThreadRequest>(
        api.updateThreadRequestSchema,
      ),
      response: jsonResponse<api.ThreadResponse>(),
    }),
    delete: defineRoute({
      path: "/threads/:id",
      method: "delete",
      request: jsonRequest<Path<"id">, api.DeleteThreadRequest>(
        api.deleteThreadRequestSchema,
      ),
      response: jsonResponse<{ ok: true }>(),
    }),
    childSummary: defineRoute({
      path: "/threads/:id/child-summary",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadChildSummaryResponse>(),
    }),
    send: defineRoute({
      path: "/threads/:id/send",
      method: "post",
      request: jsonRequest<Path<"id">, api.SendMessageRequest>(
        api.sendMessageRequestSchema,
      ),
      response: jsonResponse<api.SendMessageResponse>(),
    }),
    queuedMessages: defineRoute({
      path: "/threads/:id/queued-messages",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadQueuedMessageListResponse>(),
    }),
    createQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages",
      method: "post",
      request: jsonRequest<Path<"id">, api.CreateQueuedMessageRequest>(
        api.createQueuedMessageRequestSchema,
      ),
      response: jsonResponse<domain.ThreadQueuedMessage>({ status: 201 }),
    }),
    updateQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId",
      method: "patch",
      request: jsonRequest<
        Path<"id" | "queuedMessageId">,
        api.UpdateQueuedMessageRequest
      >(api.updateQueuedMessageRequestSchema),
      response: jsonResponse<domain.ThreadQueuedMessage>(),
    }),
    sendQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId/send",
      method: "post",
      request: jsonRequest<
        Path<"id" | "queuedMessageId">,
        api.SendQueuedMessageRequest
      >(api.sendQueuedMessageRequestSchema),
      response: jsonResponse<api.SendQueuedMessageResponse>(),
    }),
    promptHistory: defineRoute({
      path: "/threads/:id/prompt-history",
      method: "get",
      request: optionalQueryRequest<Path<"id">, api.PromptHistoryQuery>(
        api.promptHistoryQuerySchema,
      ),
      response: jsonResponse<api.PromptHistoryResponse>(),
    }),
    deleteQueuedMessage: defineRoute({
      path: "/threads/:id/queued-messages/:queuedMessageId",
      method: "delete",
      request: noRequest<Path<"id" | "queuedMessageId">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    stop: defineRoute({
      path: "/threads/:id/stop",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    compact: defineRoute({
      path: "/threads/:id/compact",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    clearContext: defineRoute({
      path: "/threads/:id/context/clear",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    cancelPlan: defineRoute({
      path: "/threads/:id/plan/cancel",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    open: defineRoute({
      path: "/threads/:id/open",
      method: "post",
      request: jsonRequest<Path<"id">, api.ThreadOpenRequest>(
        api.threadOpenRequestSchema,
      ),
      response: jsonResponse<api.ThreadOpenResponse>(),
    }),
    tabs: defineRoute({
      path: "/threads/:id/tabs",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadTabsWireResponse>(),
    }),
    updateTabs: defineRoute({
      path: "/threads/:id/tabs",
      method: "put",
      request: jsonRequest<Path<"id">, api.UpdateThreadTabsRequest>(
        api.updateThreadTabsRequestSchema,
      ),
      response: jsonResponse<api.ThreadTabsWireResponse>(),
    }),
    pin: defineRoute({
      path: "/threads/:id/pin",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadResponse>(),
    }),
    unpin: defineRoute({
      path: "/threads/:id/unpin",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadResponse>(),
    }),
    pinOrder: defineRoute({
      path: "/threads/:id/pin-order",
      method: "patch",
      request: jsonRequest<Path<"id">, api.ReorderPinnedThreadRequest>(
        api.reorderPinnedThreadRequestSchema,
      ),
      response: jsonResponse<api.ThreadListResponse>(),
    }),
    interactions: defineRoute({
      path: "/threads/:id/interactions",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadPendingInteractionsResponse>(),
    }),
    interaction: defineRoute({
      path: "/threads/:id/interactions/:interactionId",
      method: "get",
      request: noRequest<Path<"id" | "interactionId">>(),
      response: jsonResponse<domain.PendingInteraction>(),
    }),
    resolveInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/resolve",
      method: "post",
      request: jsonRequest<
        Path<"id" | "interactionId">,
        api.ResolvePendingInteractionRequest
      >(api.resolvePendingInteractionRequestSchema),
      response: jsonResponse<domain.PendingInteraction>(),
    }),
    respondToInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/respond",
      method: "post",
      request: jsonRequest<
        Path<"id" | "interactionId">,
        api.RespondPluginInteractionRequest
      >(api.respondPluginInteractionRequestSchema),
      response: jsonResponse<domain.PendingInteraction>(),
    }),
    cancelInteraction: defineRoute({
      path: "/threads/:id/interactions/:interactionId/cancel",
      method: "post",
      request: noRequest<Path<"id" | "interactionId">>(),
      response: jsonResponse<domain.PendingInteraction>(),
    }),
    archiveAll: defineRoute({
      path: "/threads/:id/archive-all",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadArchiveAllResponse>(),
    }),
    unarchive: defineRoute({
      path: "/threads/:id/unarchive",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ ok: true }>(),
    }),
    restoreEnvironment: defineRoute({
      path: "/threads/:id/restore-environment",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadResponse>(),
    }),
    read: defineRoute({
      path: "/threads/:id/read",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadResponse>(),
    }),
    unread: defineRoute({
      path: "/threads/:id/unread",
      method: "post",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<api.ThreadResponse>(),
    }),
    timeline: defineRoute({
      path: "/threads/:id/timeline",
      method: "get",
      request: optionalQueryRequest<Path<"id">, api.ThreadTimelineQuery>(
        api.threadTimelineQuerySchema,
      ),
      response: jsonResponse<api.ThreadTimelineResponse>(),
    }),
    timelineTurnSummaryDetails: defineRoute({
      path: "/threads/:id/timeline/turn-summary-details",
      method: "get",
      request: queryRequest<Path<"id">, api.TimelineTurnSummaryDetailsQuery>(
        api.timelineTurnSummaryDetailsQuerySchema,
      ),
      response: jsonResponse<api.TimelineTurnSummaryDetailsResponse>(),
    }),
    output: defineRoute({
      path: "/threads/:id/output",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<{ output: string | null }>(),
    }),
    events: defineRoute({
      path: "/threads/:id/events",
      method: "get",
      request: optionalQueryRequest<Path<"id">, api.ThreadEventsQuery>(
        api.threadEventsQuerySchema,
      ),
      response: jsonResponse<domain.ThreadEventRow[]>(),
    }),
    eventWait: defineRoute({
      path: "/threads/:id/events/wait",
      method: "get",
      request: queryRequest<Path<"id">, api.ThreadEventWaitQuery>(
        api.threadEventWaitQuerySchema,
      ),
      response: jsonResponse<domain.ThreadEventRow | null>(),
    }),
    defaultExecutionOptions: defineRoute({
      path: "/threads/:id/default-execution-options",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: jsonResponse<domain.ResolvedThreadExecutionOptions | null>(),
    }),
    hostFile: defineRoute({
      path: "/threads/:id/host-files/:filePath{.+}",
      method: "get",
      request: noRequest<Path<"id" | "filePath">>(),
      response: binaryResponse<Uint8Array>(),
    }),
  },

  system: {
    machineEnvironment: defineRoute({
      path: "/settings/machine-environment",
      method: "get",
      request: noRequest(),
      response: jsonResponse<api.MachineEnvironmentList>(),
    }),
    replaceMachineEnvironment: defineRoute({
      path: "/settings/machine-environment",
      method: "put",
      request: jsonRequest<EmptyInput, api.MachineEnvironmentReplace>(
        api.machineEnvironmentReplaceSchema,
      ),
      response: jsonResponse<api.MachineEnvironmentList>(),
    }),
    config: defineRoute({
      path: "/system/config",
      method: "get",
      request: noRequest(),
      response: jsonResponse<api.SystemConfigResponse>(),
    }),
    generalSettings: defineRoute({
      path: "/settings/general",
      method: "put",
      request: jsonRequest<EmptyInput, domain.AppSettingsUpdate>(
        domain.appSettingsUpdateSchema,
      ),
      response: jsonResponse<domain.AppSettings>(),
    }),
    keyboardSettings: defineRoute({
      path: "/settings/keyboard",
      method: "put",
      request: jsonRequest<EmptyInput, domain.AppKeybindingOverrides>(
        domain.appKeybindingOverridesSchema,
      ),
      response: jsonResponse<domain.AppKeybindingOverrides>(),
    }),
    appearance: defineRoute({
      path: "/settings/appearance",
      method: "put",
      request: jsonRequest<EmptyInput, domain.AppTheme>(domain.appThemeSchema),
      response: jsonResponse<domain.AppTheme>(),
    }),
    uiPreferences: defineRoute({
      path: "/preferences/ui",
      method: "get",
      request: noRequest(),
      response: jsonResponse<api.UiPreferencesResponse>(),
    }),
    updateUiPreference: defineRoute({
      path: "/preferences/ui/:key",
      method: "put",
      request: jsonRequest<
        api.PathUiPreferenceKey,
        api.UpdateUiPreferenceRequest
      >(api.updateUiPreferenceRequestSchema),
      response: jsonResponse<api.UiPreferenceResponse>(),
    }),
    resetUiPreference: defineRoute({
      path: "/preferences/ui/:key",
      method: "delete",
      request: noRequest<api.PathUiPreferenceKey>(),
      response: jsonResponse<api.UiPreferenceResponse>(),
    }),
    executionOptions: defineRoute({
      path: "/system/execution-options",
      method: "get",
      request: optionalQueryRequest<
        EmptyInput,
        api.SystemExecutionOptionsQuery
      >(api.systemExecutionOptionsQuerySchema),
      response: jsonResponse<api.SystemExecutionOptionsResponse>(),
    }),
    environmentProviders: defineRoute({
      path: "/system/environment-providers",
      method: "get",
      request: optionalQueryRequest<
        EmptyInput,
        api.SystemEnvironmentProvidersQuery
      >(api.systemEnvironmentProvidersQuerySchema),
      response: jsonResponse<api.SystemEnvironmentProvidersResponse>(),
    }),
    providers: defineRoute({
      path: "/system/providers",
      method: "get",
      request: optionalQueryRequest<EmptyInput, api.SystemProvidersQuery>(
        api.systemProvidersQuerySchema,
      ),
      response: jsonResponse<domain.ProviderInfo[]>(),
    }),
    providerCatalog: defineRoute({
      path: "/system/providers/catalog",
      method: "get",
      request: noRequest(),
      response: jsonResponse<api.SystemProviderCatalogEntry[]>(),
    }),
    providerEnabled: defineRoute({
      path: "/system/providers/:id/enabled",
      method: "put",
      request: jsonRequest<Path<"id">, api.SystemProviderEnabledRequest>(
        api.systemProviderEnabledRequestSchema,
      ),
      response: jsonResponse<api.SystemProviderCatalogEntry[]>(),
    }),
    providerLogo: defineRoute({
      path: "/system/providers/:id/logo",
      method: "get",
      request: noRequest<Path<"id">>(),
      response: binaryResponse<Uint8Array>(),
    }),
  },
};

export type PublicApiSchema = ApiSchemaFromRouteDescriptors<
  typeof publicApiRoutes
>;

export type PublicApiRoutes = Hono<{}, PublicApiSchema, "/">;
