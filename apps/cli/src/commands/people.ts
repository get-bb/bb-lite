import { validId, type Call } from "../call.js";
import { CliError, usageError, type Run } from "../engine.js";

const ROLES = ["owner", "member"] as const;
const LOOPBACK_LINK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/u;
const LOOPBACK_HINT =
  "This link uses the server's own loopback address. Swap in the address " +
  "people use to reach this bb, or set it under Settings > Machines > " +
  "Machine access so links come out ready to share.";

function linkLines(head: string, url: string): string[] {
  return LOOPBACK_LINK.test(url) ? [head, url, LOOPBACK_HINT] : [head, url];
}

function id(c: Call, name: string): string {
  return validId(c.arg(name), `<${name}> argument`);
}

function date(at: number): string {
  return new Date(at).toLocaleString();
}

async function currentUser(c: Call) {
  const { user } = await c.sdk.auth.session();
  if (user !== null) return user;
  const hint = "Run bb on the server machine, where it acts as the owner.";
  throw new CliError("Not signed in: the server sees no user for this CLI.", {
    code: "not_signed_in",
    hint,
  });
}

export const whoami: Run = async (c) => {
  const user = await currentUser(c);
  const email = user.email === null ? "" : ` <${user.email}>`;
  c.out({ user }, `${user.name}${email}  ${user.role}  ${user.id}`);
};

export const userList: Run = async (c) => {
  const users = await c.sdk.users.list();
  const rows = users.map((user) => ({
    ...user,
    status: user.disabledAt === null ? "active" : "disabled",
  }));
  c.rows(rows, ["id", "name", "email", "role", "status"], users);
};

export const userInvite: Run = async (c) => {
  const invite = await c.sdk.users.createInvite({
    name: c.flag("name"),
    email: c.flag("email"),
    role: c.choice("role", ROLES),
  });
  const expires = date(invite.expiresAt);
  const text = `Invite ${invite.id} for a new ${invite.role}`;
  c.out(invite, linkLines(`${text} (expires ${expires}):`, invite.url));
};

export const userInvites: Run = async (c) => {
  const invites = await c.sdk.users.invites();
  c.rows(invites, ["id", "name", "email", "role", "expiresAt"]);
};

export const userRevokeInvite: Run = async (c) => {
  const inviteId = id(c, "id");
  const result = await c.sdk.users.revokeInvite({ inviteId });
  c.out({ ...result, inviteId }, `Invite ${inviteId} revoked`);
};

export const userSignInLink: Run = async (c) => {
  const given = c.args.id;
  const userId =
    given === undefined
      ? (await currentUser(c)).id
      : validId(given, "<id> argument");
  const link = await c.sdk.users.createSignInLink({ userId });
  const expires = date(link.expiresAt);
  const text = `One-time sign-in link for ${userId}`;
  const lines = linkLines(`${text} (expires ${expires}):`, link.url);
  c.out({ ...link, userId }, lines);
};

export const userRole: Run = async (c) => {
  const wanted = c.arg("role").trim().toLowerCase();
  const role = ROLES.find((candidate) => candidate === wanted);
  if (role === undefined) {
    const expected = ROLES.join(", ");
    throw usageError(`Invalid role '${wanted}'. Expected: ${expected}.`);
  }
  const user = await c.sdk.users.update({ userId: id(c, "id"), role });
  c.out(user, `User ${user.id} is now ${user.role}`);
};

function setDisabled(disabled: boolean): Run {
  return async (c) => {
    const user = await c.sdk.users.update({ userId: id(c, "id"), disabled });
    const state = user.disabledAt === null ? "enabled" : "disabled";
    c.out(user, `User ${user.id} is ${state}`);
  };
}

export const userDisable = setDisabled(true);
export const userEnable = setDisabled(false);
