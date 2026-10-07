import * as domain from "@bb/domain";
import { z } from "zod";

const nameSchema = z.string().trim().min(1).max(80);
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(200));
const passwordSchema = z.string().min(8).max(200);

export interface AuthIdentity {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface AuthSessionResponse {
  user: domain.User | null;
  identity?: AuthIdentity | null;
}

export const loginRequestSchema = z
  .object({ email: emailSchema, password: z.string().min(1).max(200) })
  .strict();
export type LoginRequest = z.input<typeof loginRequestSchema>;

export interface InvitePreviewResponse {
  kind: "invite" | "sign-in";
  name: string | null;
  email: string | null;
  invitedByName: string | null;
  expiresAt: number;
}

export const acceptInviteRequestSchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    password: passwordSchema.optional(),
  })
  .strict();
export type AcceptInviteRequest = z.input<typeof acceptInviteRequestSchema>;

export const createInviteRequestSchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    role: domain.userRoleSchema.optional(),
  })
  .strict();
export type CreateInviteRequest = z.input<typeof createInviteRequestSchema>;

export interface UserInvite {
  id: string;
  name: string | null;
  email: string | null;
  role: domain.UserRole;
  createdByUserId: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface CreatedInviteResponse extends UserInvite {
  url: string;
}

export interface SignInLinkResponse {
  url: string;
  expiresAt: number;
}

export const updateUserRequestSchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.nullable().optional(),
    role: domain.userRoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
export type UpdateUserRequest = z.input<typeof updateUserRequestSchema>;

export const setPasswordRequestSchema = z
  .object({
    password: passwordSchema,
    currentPassword: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SetPasswordRequest = z.input<typeof setPasswordRequestSchema>;

export interface PresenceResponse {
  users: domain.UserPresence[];
}

export const updateHostSharingRequestSchema = z
  .object({ sharing: domain.machineSharingSchema })
  .strict();
export type UpdateHostSharingRequest = z.infer<
  typeof updateHostSharingRequestSchema
>;
