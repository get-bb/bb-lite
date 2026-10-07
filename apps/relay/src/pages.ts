import type { Server, User } from "./store.js";

const STYLE = `
  :root { color-scheme: light dark; --line: #8884; --dim: #888; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 48px 20px;
    display: flex; justify-content: center; }
  main { width: 100%; max-width: 420px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 0 0 16px; } .dim { color: var(--dim); }
  form.card, section { border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; margin: 0 0 16px; }
  label { display: block; font-weight: 600; margin: 0 0 12px; }
  input { display: block; width: 100%; font: inherit; padding: 8px 10px;
    margin-top: 4px; border: 1px solid var(--line); border-radius: 8px;
    background: transparent; color: inherit; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0;
    background: #222; color: #fff; cursor: pointer; }
  a.button { display: block; text-align: center; text-decoration: none;
    padding: 8px 14px; border-radius: 8px; background: #222; color: #fff; }
  button.quiet { background: transparent; color: inherit;
    border: 1px solid var(--line); }
  @media (prefers-color-scheme: dark) {
    button, a.button { background: #eee; color: #111; } }
  .error { color: #c33; } .row { display: flex; gap: 8px; align-items: center;
    justify-content: space-between; padding: 6px 0; }
  code { font-size: 13px; } a { color: inherit; }
`;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
  };
  return new Response(html, { status, headers });
}

function field(label: string, name: string, attributes: string) {
  return `<label>${label}<input name="${name}" ${attributes} required></label>`;
}

function failure(error: string | null) {
  return error === null ? "" : `<p class="error">${escapeHtml(error)}</p>`;
}

export function signInPage(
  next: string,
  error: string | null = null,
  status = 200,
): Response {
  const title = "Sign in to bb-next";
  const query = next === "" ? "" : `?next=${encodeURIComponent(next)}`;
  const body = `<h1>${title}</h1>
<p class="dim">One account for every bb server you reach through getbb.dev.</p>
${failure(error)}
<section><a class="button" href="/auth/github${escapeHtml(query)}">
Continue with GitHub</a></section>`;
  return page(title, body, status);
}

export function linkPage(
  link: { userCode: string; clientName: string; suggestedLabel: string },
  baseHost: string,
  error: string | null = null,
  status = 200,
): Response {
  const code = escapeHtml(link.userCode);
  const label = escapeHtml(link.suggestedLabel);
  const pattern = "[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?";
  const attributes = `value="${label}" pattern="${pattern}" maxlength="32"`;
  const body = `<h1>Connect a bb server</h1>
<p class="dim"><code>${escapeHtml(link.clientName)}</code> wants to be reachable
through this relay. Only approve if you just ran <code>bb connect login</code>
and it shows the code <code>${code}</code>.</p>
${failure(error)}
<form class="card" method="post" action="/link">
<input type="hidden" name="code" value="${code}">
${field(`Address (.${escapeHtml(baseHost)})`, "label", attributes)}
<div class="row"><button type="submit" name="action" value="approve">Approve
</button><button class="quiet" type="submit" name="action" value="deny"
formnovalidate>Deny</button></div></form>`;
  return page("Connect a bb server", body, status);
}

export function notice(title: string, message: string, status = 200) {
  const body = `<h1>${escapeHtml(title)}</h1>
<p class="dim">${escapeHtml(message)}</p><p><a href="/">Back</a></p>`;
  return page(title, body, status);
}

export function dashboard(
  user: User,
  servers: Server[],
  users: User[],
  origin: (label: string) => string,
): Response {
  const rows = servers.map((server) => {
    const url = origin(server.label);
    const state = server.credential_hash === null ? "signed out" : "linked";
    return `<div class="row"><a href="${url}">${escapeHtml(url)}</a>
<span class="dim">${state}</span></div>`;
  });
  const hosting =
    user.can_host === 1
      ? "Run <code>bb connect login</code> on a bb server to link it."
      : "This account can open bb servers it is invited to. Ask the relay's " +
        "admin if you want to link a server of your own.";
  const people = users.map((other) => {
    const allowed = other.can_host === 1;
    const action = `<form method="post" action="/admin/hosting">
<input type="hidden" name="userId" value="${escapeHtml(other.id)}">
<input type="hidden" name="allow" value="${allowed ? "0" : "1"}">
<button class="quiet" type="submit">${allowed ? "Revoke" : "Allow"} hosting
</button></form>`;
    return `<div class="row"><span>${escapeHtml(other.name)}
<span class="dim">@${escapeHtml(other.login)}</span></span>
${other.id === user.id ? '<span class="dim">you</span>' : action}</div>`;
  });
  const admin =
    users.length === 0
      ? ""
      : `<section><strong>People</strong>${people.join("")}</section>`;
  const body = `<h1>bb-next</h1>
<p class="dim">Signed in as ${escapeHtml(user.name)}
(@${escapeHtml(user.login)}).</p>
<section><strong>Your servers</strong>
${rows.join("") || '<p class="dim">None yet.</p>'}
<p class="dim">${hosting}</p></section>${admin}
<form method="post" action="/logout"><button class="quiet" type="submit">
Sign out</button></form>`;
  return page("bb-next", body);
}
