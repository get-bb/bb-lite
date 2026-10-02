import type { CreateThreadRequest } from "@bb/server-contract";

export type AppCreateThreadRequest = Omit<
  CreateThreadRequest,
  "origin" | "startedOnBehalfOf" | "originKind"
> &
  Partial<Pick<CreateThreadRequest, "startedOnBehalfOf">>;
