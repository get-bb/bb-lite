import {
  composer,
  useOp,
  type EnvironmentInputsProps,
  type PluginAppApi,
} from "@bb/plugin/app";
import { machineInputsSchema, modal, type MachineInputs } from "./contract.js";

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

export default function modalSandboxApp(bb: PluginAppApi): void {
  bb.add(composer.environmentInputs, { kind: PROVIDER_ID, view: ModalInputs });
}
