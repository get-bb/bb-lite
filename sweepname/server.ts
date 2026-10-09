import { fail, type PluginServerApi } from "@bb/plugin";
import { sweepname } from "./contract.js";

export default function plugin(bb: PluginServerApi): void {
  const greetings = bb.provide(sweepname.greetings, 0);

  bb.implement(sweepname.greet, ({ name }, { caller }) => {
    if (name.trim() === "") {
      fail("invalid", "Say who to greet", { hint: "bb sweepname greet <name>" });
    }
    greetings.update((count) => count + 1);
    const through = caller.door === "agent" ? " (asked by an agent)" : "";
    return `Hello, ${name}!${through}`;
  });
}
