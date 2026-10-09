import { useState } from "react";
import {
  shell,
  useCall,
  useLive,
  type PluginAppApi,
} from "@bb/plugin/app";
import { sweepname } from "./contract";

function Panel() {
  const greet = useCall(sweepname.greet);
  const greetings = useLive(sweepname.greetings) ?? 0;
  const [reply, setReply] = useState("");
  return (
    <div style={{ padding: 24 }}>
      <button onClick={() => void greet({ name: "bb" }).then(setReply)}>
        Greet
      </button>
      <p>{reply}</p>
      <p>Greetings so far: {greetings}</p>
    </div>
  );
}

export default function app(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "sweepname",
    title: "Sweepname",
    icon: "Plug02",
    path: "sweepname",
    view: Panel,
  });
}
