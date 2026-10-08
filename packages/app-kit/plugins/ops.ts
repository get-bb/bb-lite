interface OpReply {
  ok?: unknown;
  result?: unknown;
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

export async function callRemoteOp(
  name: string,
  input: unknown,
): Promise<unknown> {
  const response = await fetch(`/api/v1/ops/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bb-door": "app" },
    body: JSON.stringify(input ?? {}),
  });
  const body = (await response.json().catch(() => null)) as OpReply | null;
  if (response.ok && body?.ok === true) return body.result;
  const { message, code, details } = body ?? {};
  const fallback = `operation "${name}" failed (HTTP ${response.status})`;
  throw Object.assign(
    new Error(typeof message === "string" ? message : fallback),
    typeof code === "string" ? { code } : {},
    details === undefined ? {} : { details },
  );
}
