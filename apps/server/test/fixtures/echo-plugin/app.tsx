import { callOp, plugin } from "@bb/plugin/app";
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

export default plugin((bb) => {
  bb.slots.navPanel({ id: "echo", title: "Echo", component: EchoPanel });
});
