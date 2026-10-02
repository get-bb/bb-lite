import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateProjectRequest,
  CreateProjectSourceRequest,
  UpdateProjectRequest,
  UploadedPromptAttachment,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { registerLocalAttachmentPreview } from "@/lib/attachment-local-previews";
import { qk } from "../queries/query-keys";
import { ANY, filterFor } from "../queries/refresh";

function useProjectMutation<TVariables, TData>(config: {
  errorMessage?: string;
  showErrorToast?: boolean;
  mutationFn: (variables: TVariables) => Promise<TData>;
}) {
  const client = useQueryClient();
  const { errorMessage, showErrorToast = errorMessage !== undefined } = config;
  return useMutation({
    meta: { errorMessage, showErrorToast },
    mutationFn: config.mutationFn,
    onSuccess: () =>
      Promise.all(
        [qk.sidebar(), qk.project(ANY), qk.hostPaths()].map((queryKey) =>
          client.invalidateQueries(filterFor(queryKey)),
        ),
      ),
  });
}

export function useCreateProject() {
  return useProjectMutation({
    errorMessage: "Failed to create project.",
    mutationFn: (request: CreateProjectRequest) => sdk.projects.create(request),
  });
}

export function useUpdateProject(options?: { showErrorToast?: boolean }) {
  return useProjectMutation({
    errorMessage: "Failed to update project.",
    showErrorToast: options?.showErrorToast ?? true,
    mutationFn: ({ id, ...request }: UpdateProjectRequest & { id: string }) =>
      sdk.projects.update({ projectId: id, ...request }),
  });
}

export function useDeleteProject() {
  return useProjectMutation({
    errorMessage: "Failed to remove project.",
    mutationFn: async (projectId: string): Promise<void> => {
      await sdk.projects.delete({ projectId });
    },
  });
}

export function useAddLocalProjectSource() {
  return useProjectMutation({
    errorMessage: "Failed to add local source.",
    mutationFn: (args: { projectId: string; hostId: string; path: string }) =>
      sdk.projects.sources.add({ ...args, type: "local_path" }),
  });
}

export function useAddProjectSource() {
  return useProjectMutation({
    mutationFn: (args: {
      projectId: string;
      request: CreateProjectSourceRequest;
    }) =>
      sdk.projects.sources.add({ projectId: args.projectId, ...args.request }),
  });
}

export function useUpdateLocalProjectSource() {
  return useProjectMutation({
    errorMessage: "Failed to update local source.",
    mutationFn: (args: { projectId: string; sourceId: string; path: string }) =>
      sdk.projects.sources.update({ ...args, type: "local_path" }),
  });
}

export function useDeleteLocalProjectSource() {
  return useProjectMutation({
    errorMessage: "Failed to remove source.",
    mutationFn: async (args: {
      projectId: string;
      sourceId: string;
    }): Promise<void> => {
      await sdk.projects.sources.delete(args);
    },
  });
}

export function useUploadPromptAttachment() {
  return useMutation({
    meta: {
      errorMessage: "Failed to upload attachment.",
      showErrorToast: false,
    },
    mutationFn: async (args: {
      projectId: string;
      file: File;
    }): Promise<UploadedPromptAttachment> => {
      const uploaded = await sdk.projects.attachments.upload({
        projectId: args.projectId,
        clientFile: args.file,
      });
      registerLocalAttachmentPreview(uploaded.path, args.file);
      return uploaded;
    },
    retry: false,
  });
}
