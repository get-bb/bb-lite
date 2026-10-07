import { z } from "zod";

export const OWNER_USER_ID = "usr_owner";

export const userRoleSchema = z.enum(["owner", "member"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: userRoleSchema,
  hasPassword: z.boolean(),
  disabledAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type User = z.infer<typeof userSchema>;

export const machineSharingSchema = z.enum(["private", "shared"]);
export type MachineSharing = z.infer<typeof machineSharingSchema>;

export const userPresenceSchema = z.object({
  userId: z.string(),
  threadIds: z.array(z.string()),
});
export type UserPresence = z.infer<typeof userPresenceSchema>;

export const presenceMessageSchema = z.object({
  type: z.literal("presence"),
  users: z.array(userPresenceSchema),
});
export type PresenceMessage = z.infer<typeof presenceMessageSchema>;
