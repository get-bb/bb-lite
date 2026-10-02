import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { cn } from "@bb/shared-ui/lib/utils";

const COLOR_PALETTE = [
  { value: "slateblue", label: "Indigo" },
  { value: "steelblue", label: "Blue" },
  { value: "lightseagreen", label: "Teal" },
  { value: "mediumseagreen", label: "Green" },
  { value: "goldenrod", label: "Yellow" },
  { value: "sandybrown", label: "Orange" },
  { value: "indianred", label: "Red" },
  { value: "palevioletred", label: "Pink" },
  { value: "mediumpurple", label: "Purple" },
  { value: "slategray", label: "Gray" },
] as const;

export const DEFAULT_COLOR = COLOR_PALETTE[0].value;
const NO_LINK = "__none__";

export function derivePrefix(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const raw =
    words.length >= 2
      ? words.map((word) => word[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  return raw.replace(/^[0-9]+/, "").slice(0, 10);
}

export function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Color"
      className="flex flex-wrap gap-1.5"
    >
      {COLOR_PALETTE.map((swatch) => (
        <button
          key={swatch.value}
          type="button"
          role="radio"
          aria-checked={value === swatch.value}
          aria-label={swatch.label}
          title={swatch.label}
          onClick={() => onChange(swatch.value)}
          className={cn(
            "size-5 rounded-md",
            value === swatch.value &&
              "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
          style={{ backgroundColor: swatch.value }}
        />
      ))}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function BbProjectLinkPicker({
  value,
  onChange,
  bbProjects,
  noneLabel = "Not linked",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  bbProjects: readonly { id: string; name: string }[];
  noneLabel?: string;
}) {
  const known = bbProjects.find((project) => project.id === value);
  const unavailable = value !== null && !known ? value : null;
  return (
    <Select
      value={value ?? NO_LINK}
      onValueChange={(next) => onChange(next === NO_LINK ? null : next)}
    >
      <SelectTrigger aria-label="Linked bb project" className="h-8">
        <SelectValue>{known?.name ?? unavailable ?? noneLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_LINK}>{noneLabel}</SelectItem>
        {unavailable !== null ? (
          <SelectItem value={unavailable}>
            Unavailable · {unavailable}
          </SelectItem>
        ) : null}
        {bbProjects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
