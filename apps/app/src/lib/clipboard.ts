import { useCallback, useEffect, useState } from "react";
import { copyTextToClipboard } from "@bb/shared-ui/lib/clipboard";
import { appToast } from "@/components/ui/app-toast";

interface CopyToClipboardOptions {
  successMessage?: string | null;
  errorMessage?: string | null;
  imageUrl?: string;
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type.toLowerCase() === "image/png") {
    return blob;
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = document.createElement("img");
    image.src = objectUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("The browser cannot convert the clipboard image");
    }
    context.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
          return;
        }
        reject(new Error("The browser cannot encode the clipboard image"));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function fetchClipboardImage(imageUrl: string): Promise<Blob> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(
      `The clipboard image request failed with ${response.status}`,
    );
  }
  return convertImageBlobToPng(await response.blob());
}

async function copyTextAndImageToClipboard(
  text: string,
  imageUrl: string,
): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    return false;
  }

  try {
    const imageBlob = fetchClipboardImage(imageUrl);
    void imageBlob.catch(() => undefined);
    const clipboardData: Record<string, Blob | Promise<Blob>> = {
      "image/png": imageBlob,
    };
    if (text.length > 0) {
      clipboardData["text/plain"] = new Blob([text], { type: "text/plain" });
    }
    await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
    return true;
  } catch {
    return false;
  }
}

export async function copyToClipboardWithToast(
  text: string,
  {
    successMessage = "Copied",
    errorMessage = "Failed to copy",
    imageUrl,
  }: CopyToClipboardOptions = {},
): Promise<boolean> {
  const copied = imageUrl
    ? await copyTextAndImageToClipboard(text, imageUrl)
    : await copyTextToClipboard(text);
  if (copied) {
    if (successMessage) appToast.success(successMessage);
    return true;
  }
  if (errorMessage) appToast.error(errorMessage);
  return false;
}

export interface ClipboardCopyOptions extends CopyToClipboardOptions {
  text: string;
}

export function useClipboardCopy({
  text,
  successMessage = null,
  errorMessage = "Failed to copy",
  imageUrl,
}: ClipboardCopyOptions) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const copy = useCallback(async () => {
    if ((!text && !imageUrl) || copied) return;
    const success = await copyToClipboardWithToast(text, {
      successMessage,
      errorMessage,
      imageUrl,
    });
    if (success) setCopied(true);
  }, [text, imageUrl, copied, successMessage, errorMessage]);

  return { copied, copy };
}
