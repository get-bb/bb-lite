const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
] as const;

type Field = ReadonlySet<number>;
export type Cron = readonly [Field, Field, Field, Field, Field];

function parseField(text: string, min: number, max: number): Field {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    const [from, to] =
      range === "*"
        ? [min, max]
        : range.includes("-")
          ? range.split("-").map(Number)
          : [Number(range), stepText === undefined ? Number(range) : max];
    const valid =
      Number.isInteger(step) &&
      step > 0 &&
      Number.isInteger(from) &&
      Number.isInteger(to) &&
      from !== undefined &&
      to !== undefined &&
      from >= min &&
      to <= max &&
      from <= to;
    if (!valid) throw new Error(`"${text}" is not a cron field`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== FIELDS.length) {
    throw new Error(`"${expression}" is not a five-field cron expression`);
  }
  const [minute, hour, day, month, weekday] = FIELDS.map(({ min, max }, at) =>
    parseField(parts[at] ?? "", min, max),
  ) as [Field, Field, Field, Field, Field];
  return [minute, hour, day, month, weekday];
}

export function cronMatches(cron: Cron, at: Date): boolean {
  const [minute, hour, day, month, weekday] = cron;
  return (
    minute.has(at.getMinutes()) &&
    hour.has(at.getHours()) &&
    day.has(at.getDate()) &&
    month.has(at.getMonth() + 1) &&
    weekday.has(at.getDay())
  );
}
