import { callOp, type PluginAppApi, shell } from "@bb/plugin/app";
import clsx from "clsx";
import { useState } from "react";
import "./app.css";
import { echo } from "./contract.js";

function EchoPanel() {
  const [count] = useState(Object.keys(echo).length);
  const greet = () => callOp(echo.echo, { text: "panel" });
  return (
    <div className={clsx("echo-panel", "flex")} onClick={greet}>
      {count}
    </div>
  );
}

export default function echoPluginApp(bb: PluginAppApi): void {
  const panel = { id: "echo", title: "Echo", icon: "Radio", path: "echo" };
  bb.add(shell.navPanel, { ...panel, view: EchoPanel });
}
