import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { AppToaster } from "./components/AppToaster";
import { initializePreferredTheme } from "./hooks/useTheme";
import { initializeFavicon } from "./lib/favicon-color-preference";
import { installForeignDomMutationGuard } from "./lib/foreign-dom-mutation-guard";
import { appQueryClient } from "./lib/app-query-client";
import { installUnauthenticatedHandler } from "./lib/auth-session";
import { applyCachedAppThemeCss } from "./lib/themes";
import { AuthGate } from "./views/auth/AuthGate";
import "./app.css";

installForeignDomMutationGuard();

Error.stackTraceLimit = 50;

initializePreferredTheme();
applyCachedAppThemeCss();
initializeFavicon();
installUnauthenticatedHandler();

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, errorInfo) => {
    console.error(
      "[bb] uncaught render error — the app root was torn down",
      error,
      errorInfo.componentStack,
    );
  },
}).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={appQueryClient}>
        <BrowserRouter>
          <AuthGate>
            <App />
          </AuthGate>
          <AppToaster />
        </BrowserRouter>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
