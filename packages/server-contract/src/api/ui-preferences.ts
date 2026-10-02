import type * as domain from "@bb/domain";
import { z } from "zod";

export type PathUiPreferenceKey = { param: { key: string } };

export interface UiPreferencesResponse {
  preferences: domain.UiPreferenceEntries;
}

export interface UiPreferenceResponse<
  Key extends domain.UiPreferenceKey = domain.UiPreferenceKey,
> {
  key: Key;
  revision: number;
  value: domain.UiPreferenceValue<Key>;
}

export const updateUiPreferenceRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    value: z.unknown(),
  })
  .strict();
export type UpdateUiPreferenceRequest = z.infer<
  typeof updateUiPreferenceRequestSchema
>;
