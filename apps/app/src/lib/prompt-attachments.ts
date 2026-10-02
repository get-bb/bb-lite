import type { PromptInput } from "@bb/domain";

export function collectPromptAttachments(input: PromptInput[]) {
  const imageUrls = input.flatMap((entry) =>
    entry.type === "image" ? [entry.url] : [],
  );
  const localImagePaths = input.flatMap((entry) =>
    entry.type === "localImage" ? [entry.path] : [],
  );
  const localFilePaths = input.flatMap((entry) =>
    entry.type === "localFile" ? [entry.path] : [],
  );
  const total =
    imageUrls.length + localImagePaths.length + localFilePaths.length;
  if (total === 0) return undefined;
  return {
    webImages: imageUrls.length,
    localImages: localImagePaths.length,
    localFiles: localFilePaths.length,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(localImagePaths.length > 0 ? { localImagePaths } : {}),
    ...(localFilePaths.length > 0 ? { localFilePaths } : {}),
  };
}
