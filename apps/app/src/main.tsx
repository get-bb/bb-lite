import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { AppToaster } from "./components/AppToaster";
import { initializePreferredTheme } from "@bb/app-kit/hooks/useTheme";
import { initializeFavicon } from "@bb/app-kit/lib/favicon-color-preference";
import { installForeignDomMutationGuard } from "@bb/app-kit/lib/foreign-dom-mutation-guard";
import { appQueryClient } from "@bb/app-kit/lib/app-query-client";
import { installUnauthenticatedHandler } from "@bb/app-kit/lib/auth-session";
import { applyCachedAppThemeCss } from "@bb/app-kit/lib/themes";
import { registerCorePlugins } from "./plugins/external";
import { AuthGate } from "@bb/app-kit/views/auth/AuthGate";
import "./app.css";

installForeignDomMutationGuard();

Error.stackTraceLimit = 50;

initializePreferredTheme();
applyCachedAppThemeCss();
initializeFavicon();
installUnauthenticatedHandler();
registerCorePlugins();

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
