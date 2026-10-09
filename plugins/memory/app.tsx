import { useState } from "react";
import { settings, useCall, useOp, type PluginAppApi } from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Switch } from "@bb/shared-ui/switch";
import { Textarea } from "@bb/shared-ui/textarea";
import {
  MEMORY_KINDS,
  memory as memoryContract,
  type MemoryKind,
  type MemoryRecord,
} from "./contract.js";

const fieldClass = "space-y-1 text-xs text-muted-foreground";

function MemoryEditor({
  memory,
  onDone,
}: {
  memory: MemoryRecord;
  onDone(): void;
}) {
  const update = useCall(memoryContract.update);
  const [draft, setDraft] = useState({
    ...memory,
    tagText: memory.tags.join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await update({
        memoryId: memory.id,
        expectedVersion: memory.version,
        summary: draft.summary,
        details: draft.details,
        kind: draft.kind,
        tags: draft.tagText
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ""),
        importance: draft.importance,
        pinned: draft.pinned,
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldClass}>
          <span>Summary</span>
          <Input
            aria-label="Memory summary"
            value={draft.summary}
            onChange={(event) =>
              setDraft({ ...draft, summary: event.target.value })
            }
          />
        </label>
        <label className={fieldClass}>
          <span>Tags</span>
          <Input
            aria-label="Memory tags"
            value={draft.tagText}
            onChange={(event) =>
              setDraft({ ...draft, tagText: event.target.value })
            }
          />
        </label>
      </div>
      <label className={`block ${fieldClass}`}>
        <span>Details</span>
        <Textarea
          aria-label="Memory details"
          rows={6}
          value={draft.details}
          onChange={(event) =>
            setDraft({ ...draft, details: event.target.value })
          }
        />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className={fieldClass}>
          <span>Kind</span>
          <select
            aria-label="Memory kind"
            className="block h-8 rounded-md border bg-transparent px-2 text-sm text-foreground"
            value={draft.kind}
            onChange={(event) => {
              const kind = MEMORY_KINDS.find((k) => k === event.target.value);
              if (kind) setDraft({ ...draft, kind });
            }}
          >
            {MEMORY_KINDS.map((kind: MemoryKind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className={fieldClass}>
          <span>Importance</span>
          <Input
            aria-label="Memory importance"
            type="number"
            min={0}
            max={100}
            value={draft.importance}
            onChange={(event) =>
              setDraft({ ...draft, importance: Number(event.target.value) })
            }
          />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch
            aria-label="Pinned memory"
            checked={draft.pinned}
            onCheckedChange={(pinned) => setDraft({ ...draft, pinned })}
          />
          Pinned
        </label>
      </div>
      {error && <p className="text-xs text-destructive-text">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={saving} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

function MemorySettings() {
  const list = useOp(memoryContract.list, {});
  const remove = useCall(memoryContract.delete);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const memories = list.data?.memories ?? [];
  const forget = async (memory: MemoryRecord) => {
    setError(null);
    try {
      await remove({ memoryId: memory.id, expectedVersion: memory.version });
      list.refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  if (list.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading memories…</p>;
  }
  return (
    <div className="space-y-2">
      {list.error && (
        <p className="text-xs text-destructive-text">{list.error.message}</p>
      )}
      {error && <p className="text-xs text-destructive-text">{error}</p>}
      {memories.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No memories are stored yet.
        </p>
      )}
      {memories.map((memory) =>
        editing === memory.id ? (
          <MemoryEditor
            key={memory.id}
            memory={memory}
            onDone={() => {
              setEditing(null);
              list.refetch();
            }}
          />
        ) : (
          <div
            key={memory.id}
            className="flex items-start justify-between gap-3 rounded-md border p-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium">{memory.name}</p>
              <p className="text-sm text-muted-foreground">{memory.summary}</p>
              <p className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span title={memory.projectId ?? undefined}>
                  {memory.scope}/{memory.kind}
                </span>
                <span>importance {memory.importance}</span>
                {memory.pinned && <span>pinned</span>}
                {memory.tags.length > 0 && (
                  <span>{memory.tags.join(", ")}</span>
                )}
                <span>v{memory.version}</span>
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(memory.id)}
              >
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => forget(memory)}>
                Delete
              </Button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

export default function memoryApp(bb: PluginAppApi): void {
  bb.add(settings.section, {
    id: "memory",
    title: "Memory",
    description:
      "Durable memories agents search and save across threads and projects.",
    view: MemorySettings,
  });
}
