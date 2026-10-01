import type { z } from "zod";

export interface RpcMethodContract {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}
export type RpcContract = Readonly<Record<string, RpcMethodContract>>;

export type RpcHandlers<Contract extends RpcContract> = {
  [Method in keyof Contract]: (
    input: z.output<Contract[Method]["input"]>,
  ) =>
    | z.input<Contract[Method]["output"]>
    | Promise<z.input<Contract[Method]["output"]>>;
};

export interface RpcError {
  code:
    | `invalid_${"json" | "input" | "output"}`
    | "handler_error"
    | "unknown_method"
    | "plugin_unavailable";
  message: string;
  issues?: { message: string; path: PropertyKey[] }[];
}

export function defineRpcContract<const Contract extends RpcContract>(
  contract: Contract,
): Contract {
  return contract;
}
