import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { PromptInput } from "@bb/domain";

export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiPrompt {
  message: string;
  images: PiImage[];
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function readImage(path: string): PiImage | null {
  try {
    const data = readFileSync(path).toString("base64");
    const mimeType =
      MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    return { type: "image", data, mimeType };
  } catch {
    return null;
  }
}

function dataImage(url: string): PiImage | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match?.[1] || match[2] === undefined) return null;
  return { type: "image", mimeType: match[1], data: match[2] };
}

interface Skill {
  chunk: number;
  start: number;
  end: number;
  name: string;
}

export function piPrompt(input: readonly PromptInput[]): PiPrompt {
  const chunks: string[] = [];
  const images: PiImage[] = [];
  const skills: Skill[] = [];
  for (const item of input) {
    if (item.type === "text") {
      const chunk = chunks.push(item.text) - 1;
      for (const { start, end, resource } of item.mentions) {
        const selected =
          resource.kind === "command" &&
          resource.source === "skill" &&
          (resource.trigger === "/" || resource.trigger === "$") &&
          item.text.slice(start, end) === `${resource.trigger}${resource.name}`;
        if (selected) skills.push({ chunk, start, end, name: resource.name });
      }
    } else if (item.type === "localImage") {
      const image = readImage(item.path);
      if (image) images.push(image);
    } else if (item.type === "image") {
      const image = dataImage(item.url);
      if (image) images.push(image);
      else chunks.push(`[Attached image: ${item.url}]`);
    } else {
      chunks.push(`[Attached file: ${item.path}]`);
    }
  }
  const [skill] = skills;
  const text = skill && skills.length === 1 ? chunks[skill.chunk] : undefined;
  if (skill && text !== undefined) {
    chunks[skill.chunk] =
      `${text.slice(0, skill.start)}${text.slice(skill.end)}`;
    const rest = chunks.join("\n");
    const separator = rest === "" || rest.startsWith(" ") ? "" : " ";
    return { message: `/skill:${skill.name}${separator}${rest}`, images };
  }
  return { message: chunks.join("\n"), images };
}
