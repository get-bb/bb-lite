import { useRef, useState, type ReactNode } from "react";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { InlineImageGalleryContext } from "@/components/ui/inline-image-gallery-context";

interface GalleryState {
  images: { src: string; alt: string }[];
  index: number;
}

function isEligible(image: HTMLImageElement): boolean {
  if (image.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
  const clipped = image.closest("[data-image-gallery-clipped]");
  if (clipped) {
    const bounds = clipped.getBoundingClientRect();
    const imageBounds = image.getBoundingClientRect();
    return imageBounds.top >= bounds.top && imageBounds.bottom <= bounds.bottom;
  }
  return true;
}

export function TimelineImageGallery({ children }: { children: ReactNode }) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [gallery, setGallery] = useState<GalleryState | null>(null);
  const openImage = (selected: HTMLImageElement) => {
    const elements = Array.from(
      timelineRef.current?.querySelectorAll<HTMLImageElement>(
        "img[data-markdown-image]",
      ) ?? [],
    ).filter((image) => image === selected || isEligible(image));
    setGallery({
      images: elements.map((image) => ({
        src: image.currentSrc || image.src,
        alt: image.alt,
      })),
      index: Math.max(0, elements.indexOf(selected)),
    });
  };
  const step = (delta: number) => {
    setGallery(
      (current) => current && { ...current, index: current.index + delta },
    );
  };
  const selected = gallery?.images[gallery.index];
  const count = gallery?.images.length ?? 0;
  return (
    <InlineImageGalleryContext.Provider value={openImage}>
      <div ref={timelineRef} className="contents">
        {children}
      </div>
      <ImageLightbox
        imageSrc={selected?.src ?? null}
        imageAlt={selected?.alt ?? "Image"}
        title="Timeline image preview"
        hasMultipleImages={count > 1}
        previousDisabled={gallery?.index === 0}
        nextDisabled={gallery !== null && gallery.index === count - 1}
        navigationStatus={
          gallery && count > 1 ? `${gallery.index + 1} / ${count}` : undefined
        }
        onClose={() => setGallery(null)}
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
      />
    </InlineImageGalleryContext.Provider>
  );
}
