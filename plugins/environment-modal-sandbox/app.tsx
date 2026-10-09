import { useEffect, useState } from "react";
import {
  callOp,
  composer,
  settings,
  useOp,
  type EnvironmentInputsProps,
  type PluginAppApi,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import {
  launchOptionsSchema,
  machineInputsSchema,
  modal,
  type LaunchOptions,
  type MachineInputs,
} from "./contract.js";

type Preset = LaunchOptions["presets"][number];
type Image = LaunchOptions["images"][number];

const PROVIDER_ID = "modal-sandbox";
const SELECT_CLASS =
  "h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground";

function Choice(props: {
  label: string;
  value: string | undefined;
  names: string[];
  onChange(name: string): void;
}) {
  if (props.names.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {props.label}
      <select
        className={SELECT_CLASS}
        value={props.value ?? props.names[0]}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModalInputs({ value, onChange }: EnvironmentInputsProps) {
  const options = useOp(modal.launchOptions, {});
  const parsed = machineInputsSchema.safeParse(value ?? {});
  const inputs: MachineInputs = parsed.success ? parsed.data : {};
  if (options.data === undefined) return null;
  const update = (next: MachineInputs) =>
    onChange({ status: "ready", value: { ...inputs, ...next } });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Choice
        label="Size"
        value={inputs.preset}
        names={options.data.presets.map((preset) => preset.name)}
        onChange={(preset) => update({ preset })}
      />
      <Choice
        label="Image"
        value={inputs.image}
        names={options.data.images.map((image) => image.name)}
        onChange={(image) => update({ image })}
      />
    </div>
  );
}

const replace = <T,>(list: T[], index: number, item: T) =>
  list.map((entry, at) => (at === index ? item : entry));
const without = <T,>(list: T[], index: number) =>
  list.filter((_, at) => at !== index);

function PresetRow(props: {
  preset: Preset;
  onChange(preset: Preset): void;
  onRemove(): void;
}) {
  const { preset } = props;
  const number = (value: string) => (value === "" ? 0 : Number(value));
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Preset name"
        value={preset.name}
        onChange={(event) =>
          props.onChange({ ...preset, name: event.target.value })
        }
      />
      <Input
        aria-label="CPU"
        type="number"
        value={preset.cpu}
        onChange={(event) =>
          props.onChange({ ...preset, cpu: number(event.target.value) })
        }
      />
      <Input
        aria-label="Memory (MiB)"
        type="number"
        value={preset.memoryMiB}
        onChange={(event) =>
          props.onChange({ ...preset, memoryMiB: number(event.target.value) })
        }
      />
      <Button variant="ghost" size="sm" onClick={props.onRemove}>
        Remove
      </Button>
    </div>
  );
}

function ImageRow(props: {
  image: Image;
  standard: boolean;
  onChange(image: Image): void;
  onRemove(): void;
}) {
  const { image } = props;
  const value =
    image.source === "dockerfile" ? image.dockerfile : image.imageId;
  const update = (source: Image["source"], text: string): Image =>
    source === "dockerfile"
      ? { name: image.name, source, dockerfile: text }
      : { name: image.name, source, imageId: text };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Image name"
          value={image.name}
          disabled={props.standard}
          onChange={(event) =>
            props.onChange({ ...image, name: event.target.value })
          }
        />
        <select
          className={SELECT_CLASS}
          value={image.source}
          disabled={props.standard}
          onChange={(event) =>
            props.onChange(
              update(
                event.target.value === "image-id" ? "image-id" : "dockerfile",
                value,
              ),
            )
          }
        >
          <option value="dockerfile">Dockerfile</option>
          <option value="image-id">Modal image id</option>
        </select>
        {props.standard ? null : (
          <Button variant="ghost" size="sm" onClick={props.onRemove}>
            Remove
          </Button>
        )}
      </div>
      {image.source === "dockerfile" ? (
        <Textarea
          aria-label="Dockerfile"
          className="font-mono text-xs"
          rows={6}
          value={value}
          disabled={props.standard}
          onChange={(event) =>
            props.onChange(update(image.source, event.target.value))
          }
        />
      ) : (
        <Input
          aria-label="Modal image id"
          value={value}
          onChange={(event) =>
            props.onChange(update(image.source, event.target.value))
          }
        />
      )}
    </div>
  );
}

function LaunchOptionsSettings() {
  const loaded = useOp(modal.launchOptions, {});
  const [draft, setDraft] = useState<LaunchOptions | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (loaded.data !== undefined) setDraft(loaded.data);
  }, [loaded.data]);
  if (draft === null) return null;
  const save = () => {
    const parsed = launchOptionsSchema.safeParse(draft);
    if (!parsed.success) {
      setStatus(parsed.error.issues[0]?.message ?? "Invalid launch options");
      return;
    }
    setStatus("Saving…");
    callOp(modal.updateLaunchOptions, parsed.data).then(
      (saved) => {
        setDraft(saved);
        setStatus("Saved");
      },
      (error: unknown) =>
        setStatus(error instanceof Error ? error.message : String(error)),
    );
  };
  const presets = draft.presets;
  const images = draft.images;
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Sandbox sizes</h3>
        <p className="text-xs text-muted-foreground">
          The first size is the default. Without sizes, sandboxes get 1 CPU and
          2048 MiB.
        </p>
        {presets.map((preset, index) => (
          <PresetRow
            key={index}
            preset={preset}
            onChange={(next) =>
              setDraft({ ...draft, presets: replace(presets, index, next) })
            }
            onRemove={() =>
              setDraft({ ...draft, presets: without(presets, index) })
            }
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft({
              ...draft,
              presets: [
                ...presets,
                { name: `Size ${presets.length + 1}`, cpu: 1, memoryMiB: 2048 },
              ],
            })
          }
        >
          Add size
        </Button>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Images</h3>
        <p className="text-xs text-muted-foreground">
          The Default image is the saved Dockerfile (bb modal image set).
        </p>
        {images.map((image, index) => (
          <ImageRow
            key={index}
            image={image}
            standard={index === 0}
            onChange={(next) =>
              setDraft({ ...draft, images: replace(images, index, next) })
            }
            onRemove={() =>
              setDraft({ ...draft, images: without(images, index) })
            }
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft({
              ...draft,
              images: [
                ...images,
                {
                  name: `Image ${images.length + 1}`,
                  source: "image-id",
                  imageId: "",
                },
              ],
            })
          }
        >
          Add image
        </Button>
      </section>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save}>
          Save
        </Button>
        {status === null ? null : (
          <span className="text-xs text-muted-foreground">{status}</span>
        )}
      </div>
    </div>
  );
}

export default function modalSandboxApp(bb: PluginAppApi): void {
  bb.add(composer.environmentInputs, { kind: PROVIDER_ID, view: ModalInputs });
  bb.add(settings.section, {
    id: "launch-options",
    view: LaunchOptionsSettings,
  });
}
