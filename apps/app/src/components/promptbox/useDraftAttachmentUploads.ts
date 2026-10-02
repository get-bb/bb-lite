import { useState } from "react";
import { nanoid } from "nanoid";
import type { PromptDraftAttachment } from "@bb/client-core";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { useLatestRef } from "@/hooks/useLatestRef";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { BbHttpError } from "@/lib/sdk";

export interface PendingAttachmentUpload {
  id: string;
  file: File;
}

interface UploadState {
  targetKey: string | null;
  error: string | null;
  uploads: readonly PendingAttachmentUpload[];
}

const NO_UPLOADS: UploadState = { targetKey: null, error: null, uploads: [] };

export function useDraftAttachmentUploads(
  projectId: string,
  target: {
    key: string;
    addAttachment: (attachment: PromptDraftAttachment) => void;
  } | null,
) {
  const uploadPromptAttachment = useUploadPromptAttachment();
  const targetRef = useLatestRef(target);
  const [state, setState] = useState(NO_UPLOADS);
  const targetKey = target?.key ?? null;
  const current = state.targetKey === targetKey ? state : NO_UPLOADS;

  const handleAttachFiles = async (files: File[]) => {
    const key = targetRef.current?.key;
    if (key === undefined || files.length === 0) return;
    const uploads = files.map((file) => ({ id: nanoid(), file }));
    const update = (change: (uploadState: UploadState) => UploadState) =>
      setState((previous) =>
        previous.targetKey === key ? change(previous) : previous,
      );
    setState((previous) => ({
      targetKey: key,
      error: null,
      uploads: [
        ...(previous.targetKey === key ? previous.uploads : []),
        ...uploads,
      ],
    }));
    const failure = { files: [] as string[], reason: null as string | null };
    for (const upload of uploads) {
      await uploadPromptAttachment
        .mutateAsync({ projectId, file: upload.file })
        .then(
          (uploaded) => {
            if (targetRef.current?.key === key) {
              targetRef.current.addAttachment(uploaded);
            }
          },
          (error: unknown) => {
            failure.files.push(upload.file.name);
            if (error instanceof BbHttpError && failure.reason === null) {
              failure.reason = getMutationErrorMessage({
                error,
                fallbackMessage: "Request failed",
              });
            }
          },
        );
      update((previous) => ({
        ...previous,
        uploads: previous.uploads.filter((item) => item.id !== upload.id),
      }));
    }
    if (failure.files.length > 0) {
      const names = failure.files.join(", ");
      update((previous) => ({
        ...previous,
        error:
          failure.reason === null
            ? `Failed to attach: ${names}`
            : `Failed to attach ${names}: ${failure.reason}`,
      }));
    }
  };

  return {
    attachmentError: current.error,
    setAttachmentError: (error: string | null) =>
      setState((previous) => ({
        targetKey,
        error,
        uploads: previous.targetKey === targetKey ? previous.uploads : [],
      })),
    handleAttachFiles,
    isAttachingFiles: current.uploads.length > 0,
    pendingUploads: current.uploads,
  };
}
