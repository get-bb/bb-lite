import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

export function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (key: string, work: () => Promise<unknown>) => {
    setPending(key);
    setProblem(null);
    try {
      await work();
      await router.invalidate();
      return true;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setPending(null);
    }
  };
  return { pending, problem, run };
}
