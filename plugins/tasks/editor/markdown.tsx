import { useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "@bb/plugin/app";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@bb/shared-ui/lib/utils";
import { reportError } from "../shell/data.js";

type Variant = "doc" | "comment";

export function MarkdownView({
  value,
  variant = "doc",
}: {
  value: string;
  variant?: Variant;
}) {
  const content = value
    .replace(/\]\(bbtask:\/\//gu, "](/plugins/tasks/tasks/task/")
    .replace(/\]\(bbthread:\/\//gu, "](/threads/");
  return (
    <Markdown
      content={content}
      className={variant === "comment" ? "text-[13px]" : undefined}
    />
  );
}

export function fileLink(file: File, url: string): string {
  const image = file.type.startsWith("image/") ? "!" : "";
  return `${image}[${file.name}](${url})`;
}

interface EditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  variant?: Variant;
  className?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
  onSubmit?: () => void;
  onUploadFile?: (file: File) => Promise<{ url: string }>;
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  variant = "doc",
  className,
  autoFocus,
  onBlur,
  onSubmit,
  onUploadFile,
}: EditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const isPointerCoarse = usePointerCoarse();
  useLayoutEffect(() => {
    const area = ref.current;
    if (area === null) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [value]);

  const takeFiles = (files: File[], event: { preventDefault(): void }) => {
    if (files.length === 0 || !onUploadFile) return;
    event.preventDefault();
    for (const file of files) {
      onUploadFile(file).then(({ url }) => {
        const area = ref.current;
        const text = area?.value ?? value;
        const at = area?.selectionStart ?? text.length;
        const link = fileLink(file, url);
        onChange(`${text.slice(0, at)}${link}${text.slice(at)}`);
      }, reportError);
    }
  };

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      enterKeyHint={onSubmit ? (isPointerCoarse ? "enter" : "send") : undefined}
      aria-label={placeholder}
      className={cn(
        "block w-full min-w-0 resize-none bg-transparent outline-none placeholder:text-muted-foreground",
        variant === "doc"
          ? "text-sm leading-[1.65]"
          : "text-[13px] leading-[1.55]",
        className,
      )}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      onPaste={(event) => takeFiles([...event.clipboardData.files], event)}
      onDrop={(event) => takeFiles([...event.dataTransfer.files], event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.currentTarget.blur();
        const plain = !event.shiftKey && !event.altKey;
        const composing = event.nativeEvent.isComposing;
        if (!onSubmit || event.key !== "Enter" || !plain || composing) return;
        if (isPointerCoarse && !event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        onSubmit();
      }}
    />
  );
}

export function MarkdownField(editor: EditorProps) {
  const [editing, setEditing] = useState(false);
  const { value, placeholder, className, onBlur } = editor;
  if (editing) {
    const leave = () => {
      setEditing(false);
      onBlur?.();
    };
    return <MarkdownEditor {...editor} autoFocus onBlur={leave} />;
  }
  return (
    <div
      role="textbox"
      tabIndex={0}
      aria-label="Description"
      className={cn("cursor-text", className)}
      onKeyDown={(event) => {
        if (event.key === "Enter") setEditing(true);
      }}
      onClick={({ target }) => {
        const interactive =
          target instanceof Element && target.closest("a, button, img");
        const selecting = window.getSelection()?.isCollapsed === false;
        if (!interactive && !selecting) setEditing(true);
      }}
    >
      {value.trim() === "" ? (
        <p className="text-sm text-muted-foreground">{placeholder}</p>
      ) : (
        <MarkdownView value={value} />
      )}
    </div>
  );
}
