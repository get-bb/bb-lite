import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateInviteRequest,
  SetPasswordRequest,
  UpdateUserRequest,
} from "@bb/server-contract";
import { signOut } from "@bb/app-kit/lib/auth-session";
import { sdk } from "@bb/app-kit/lib/sdk";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";
import { filterFor } from "@bb/app-kit/hooks/queries/refresh";

type UserTarget = { userId: string };

function useUserMutation<TVariables, TData>(config: {
  errorMessage: string;
  mutationFn: (variables: TVariables) => Promise<TData>;
}) {
  const client = useQueryClient();
  return useMutation({
    meta: { errorMessage: config.errorMessage },
    mutationFn: config.mutationFn,
    onSuccess: () =>
      Promise.all(
        [qk.users(), qk.userInvites(), qk.authSession()].map((queryKey) =>
          client.invalidateQueries(filterFor(queryKey)),
        ),
      ),
  });
}

export function useUpdateUser(errorMessage = "Failed to update user.") {
  return useUserMutation({
    errorMessage,
    mutationFn: (request: UpdateUserRequest & UserTarget) =>
      sdk.users.update(request),
  });
}

export function useSetUserPassword() {
  return useUserMutation({
    errorMessage: "Failed to set password.",
    mutationFn: (request: SetPasswordRequest & UserTarget) =>
      sdk.users.setPassword(request),
  });
}

export function useCreateSignInLink() {
  return useMutation({
    meta: { errorMessage: "Failed to create sign-in link." },
    mutationFn: (target: UserTarget) => sdk.users.createSignInLink(target),
  });
}

export function useCreateUserInvite() {
  return useUserMutation({
    errorMessage: "Failed to create invite.",
    mutationFn: (request: CreateInviteRequest) =>
      sdk.users.createInvite(request),
  });
}

export function useRevokeUserInvite() {
  return useUserMutation({
    errorMessage: "Failed to revoke invite.",
    mutationFn: (inviteId: string) => sdk.users.revokeInvite({ inviteId }),
  });
}

export function useSignOut() {
  return useMutation({
    meta: { errorMessage: "Failed to sign out." },
    mutationFn: signOut,
  });
}
