import { useEffect } from "react";
import {
  defaultFaviconColor,
  faviconColorPreferenceSchema,
  type FaviconColor,
  type FaviconColorPreference,
} from "@bb/domain";
import {
  DARK_COLOR_SCHEME_QUERY,
  getMediaQuerySnapshot,
  subscribeMediaQuery,
} from "@bb/shared-ui/hooks/use-media-query";
import { useSystemConfig } from "../hooks/queries/system-queries";

const FAVICON_COLOR_STORAGE_KEY = "bb.faviconColor";
const UNREAD_BADGE_FILL = "#e00000";

type FaviconBadge = "none" | "unread";

export const FAVICON_COLOR_VALUES: Record<FaviconColor, string> = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffba18",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  purple: "#8e4ec6",
  pink: "#d6409f",
};

function readCachedColor(): FaviconColorPreference {
  try {
    const parsed = faviconColorPreferenceSchema.safeParse(
      localStorage.getItem(FAVICON_COLOR_STORAGE_KEY),
    );
    return parsed.success ? parsed.data : defaultFaviconColor;
  } catch {
    return defaultFaviconColor;
  }
}

let color = readCachedColor();
let badge: FaviconBadge = "none";
let renderToken = 0;
const baseImages = new Map<string, Promise<HTMLImageElement>>();

export function getFaviconGlyphHref(): string {
  return import.meta.env.DEV ? "/favicon-32x32-dev.png" : "/favicon-32x32.png";
}

function loadBaseImage(src: string): Promise<HTMLImageElement> {
  let pending = baseImages.get(src);
  if (pending === undefined) {
    pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to load ${src}`));
      image.src = src;
    });
    baseImages.set(src, pending);
    pending.catch(() => baseImages.delete(src));
  }
  return pending;
}

async function faviconHref(baseHref: string): Promise<string> {
  if (badge === "none" && color === "default") return baseHref;
  const image = await loadBaseImage(baseHref);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.drawImage(image, 0, 0);
  if (color !== "default") {
    context.globalCompositeOperation = "source-in";
    context.fillStyle = FAVICON_COLOR_VALUES[color];
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "source-over";
  }
  if (badge === "unread") {
    const scale = Math.min(canvas.width, canvas.height) / 32;
    context.beginPath();
    context.arc(28 * scale, 6 * scale, 3.5 * scale, 0, Math.PI * 2);
    context.fillStyle = UNREAD_BADGE_FILL;
    context.fill();
  }
  return canvas.toDataURL("image/png");
}

function setLinkHref(id: string, href: string): void {
  const link = document.getElementById(id);
  if (link instanceof HTMLLinkElement) link.href = href;
}

async function renderFavicon(): Promise<void> {
  const token = ++renderToken;
  const tint = color === defaultFaviconColor ? "" : `-${color}`;
  setLinkHref("app-manifest", `/manifest${tint}.webmanifest`);
  setLinkHref("apple-touch-icon", `/apple-touch-icon${tint}.png`);
  const variant = import.meta.env.DEV
    ? "-dev"
    : getMediaQuerySnapshot(DARK_COLOR_SCHEME_QUERY)
      ? "-dark"
      : "";
  const sizes = [32, 16];
  const hrefs = await Promise.all(
    sizes.map((size) => faviconHref(`/favicon-${size}x${size}${variant}.png`)),
  ).catch(() => null);
  if (hrefs === null || token !== renderToken) return;
  sizes.forEach((size, index) => {
    setLinkHref(`favicon-${size}`, hrefs[index] ?? "");
  });
}

export function initializeFavicon(): void {
  subscribeMediaQuery(DARK_COLOR_SCHEME_QUERY, () => void renderFavicon());
  void renderFavicon();
}

export function useFaviconColorSync(): void {
  const faviconColor = useSystemConfig().data?.appearance.faviconColor;
  useEffect(() => {
    if (faviconColor === undefined || faviconColor === color) return;
    color = faviconColor;
    try {
      if (color === defaultFaviconColor) {
        localStorage.removeItem(FAVICON_COLOR_STORAGE_KEY);
      } else localStorage.setItem(FAVICON_COLOR_STORAGE_KEY, color);
    } catch {}
    void renderFavicon();
  }, [faviconColor]);
}

export function useFaviconBadge(next: FaviconBadge): void {
  useEffect(() => {
    const show = (value: FaviconBadge) => {
      if (badge === value) return;
      badge = value;
      void renderFavicon();
    };
    show(next);
    return () => show("none");
  }, [next]);
}
