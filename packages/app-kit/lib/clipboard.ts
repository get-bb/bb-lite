import { useEffect, useState } from "react";
import { copyTextToClipboard } from "@bb/shared-ui/lib/clipboard";
import { appToast } from "../components/ui/app-toast";

interface CopyToClipboardOptions {
  successMessage?: string | null;
  errorMessage?: string | null;
  imageUrl?: string;
}

async function fetchPngImage(imageUrl: string): Promise<Blob> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`The clipboard image request failed (${response.status})`);
  }
  const blob = await response.blob();
  if (blob.type.toLowerCase() === "image/png") return blob;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = document.createElement("img");
    image.src = objectUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png ? resolve(png) : reject(new Error("Cannot encode the image")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function copyTextAndImage(
  text: string,
  imageUrl: string,
): Promise<boolean> {
  try {
    const image = fetchPngImage(imageUrl);
    image.catch(() => undefined);
    const items: Record<string, Blob | Promise<Blob>> = { "image/png": image };
    if (text.length > 0) {
      items["text/plain"] = new Blob([text], { type: "text/plain" });
    }
    await navigator.clipboard.write([new ClipboardItem(items)]);
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
  const copied = await (imageUrl
    ? copyTextAndImage(text, imageUrl)
    : copyTextToClipboard(text));
  const message = copied ? successMessage : errorMessage;
  if (message) appToast[copied ? "success" : "error"](message);
  return copied;
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
  const copy = async () => {
    if ((!text && !imageUrl) || copied) return;
    const options = { successMessage, errorMessage, imageUrl };
    if (await copyToClipboardWithToast(text, options)) setCopied(true);
  };
  return { copied, copy };
}
