import { describe, expect, it } from "vitest";
import {
  CURSOR_ACP_MAINTENANCE,
  __testing,
  getAcpProviderStatus,
  type AcpMaintenanceDialect,
} from "../../../runner/bridge/provider-maintenance.js";

function missingAgent(maintenance: AcpMaintenanceDialect | undefined) {
  return {
    providerId: "acp-test",
    maintenance,
    command: "/nonexistent/bb-provider-acp-test/agent",
    missingMessage: "agent is missing",
    signedOutMessage: "sign in",
  };
}

describe("ACP provider maintenance", () => {
  it("normalizes Cursor plan and spend limits without reading daemon state", () => {
    expect(
      __testing.normalizeUsage(
        {
          billingCycleEnd: "1767225600000",
          planUsage: { totalPercentUsed: 72.2 },
          spendLimitUsage: {
            overallUsed: "1250",
            overallLimit: "5000",
          },
        },
        { planInfo: { planName: "Pro" } },
        "cursor@example.com",
      ),
    ).toEqual({
      status: "ok",
      accountEmail: "cursor@example.com",
      planLabel: "Pro",
      windows: [
        {
          label: "Plan usage",
          usedPercent: 72,
          resetsAt: "2026-01-01T00:00:00.000Z",
        },
        {
          label: "On-demand spend",
          usedPercent: 25,
          resetsAt: "2026-01-01T00:00:00.000Z",
          cost: { usedUsdCents: 1250, limitUsdCents: 5000 },
        },
      ],
    });
  });

  it("offers the installer only when the agent is missing and maintained", async () => {
    const cursor = await getAcpProviderStatus(
      missingAgent(CURSOR_ACP_MAINTENANCE),
    );
    expect(cursor).toEqual({
      providerId: "acp-test",
      installed: false,
      executablePath: null,
      version: null,
      auth: "unknown",
      message: "agent is missing",
      installAction: {
        kind: "install",
        command: CURSOR_ACP_MAINTENANCE.installer().displayCommand,
      },
    });
    expect(CURSOR_ACP_MAINTENANCE.installer()).toMatchObject({
      command: "sh",
    });
    expect(cursor.installAction?.command).toContain(
      "curl -fsSL https://cursor.com/install",
    );
    expect(await getAcpProviderStatus(missingAgent(undefined))).toEqual({
      providerId: "acp-test",
      installed: false,
      executablePath: null,
      version: null,
      auth: "unknown",
      message: "agent is missing",
    });
    expect(
      await getAcpProviderStatus({
        ...missingAgent(CURSOR_ACP_MAINTENANCE),
        command: null,
      }),
    ).toEqual({
      providerId: "acp-test",
      installed: true,
      executablePath: null,
      version: null,
      auth: "unknown",
      message: "The ACP provider has no launch command.",
    });
  });
});
