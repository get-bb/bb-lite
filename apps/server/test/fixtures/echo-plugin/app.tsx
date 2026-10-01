import { definePluginApp } from "@bb/plugin/app";
import clsx from "clsx";
import { useState } from "react";
import "./app.css";

function EchoPanel() {
  const [count] = useState(1);
  return <div className={clsx("echo-panel", "flex")}>{count}</div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "echo", title: "Echo", component: EchoPanel });
});
