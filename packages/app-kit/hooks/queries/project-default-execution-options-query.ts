import { callOp, projects } from "@bb/plugin/app";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { QueryOptions } from "./query-helpers";
import { qk } from "./query-keys";

export function useProjectDefaultExecutionOptions(
  args: { projectId: string | undefined },
  options?: QueryOptions,
) {
  const projectId = args.projectId ?? "";
  return useQuery({
    queryKey: qk.projectExecution(projectId),
    queryFn: ({ signal }) =>
      callOp(projects.defaultExecutionOptions, { projectId }, { signal }),
    enabled: (options?.enabled ?? true) && projectId.length > 0,
    staleTime: 10_000,
    placeholderData: projectId ? keepPreviousData : undefined,
  });
}
