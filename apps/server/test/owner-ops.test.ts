import { expect, it } from "vitest";
import { pool } from "../../../plugins/account-pool/src/contract.js";
import { bbAccount } from "../../../plugins/bb-account/contract.js";
import { bbAi } from "../../../plugins/bb-ai/contract.js";
import { concurrencyLimit } from "../../../plugins/concurrency-limit/contract.js";
import { connect } from "../../../plugins/connect/src/contract.js";

it("keeps server-wide accounts, remote access and limits to owners", () => {
  const ops = [
    pool.accountAdd,
    pool.accountUpdate,
    pool.accountRefresh,
    pool.routingSet,
    pool.configSet,
    pool.loginStart,
    pool.loginComplete,
    bbAccount.login,
    bbAccount.logout,
    bbAi.update,
    concurrencyLimit.update,
    connect.login,
    connect.logout,
    connect.setEnabled,
    connect.expose,
    connect.unexpose,
  ];
  const memberOps = ops.filter((op) => op.allow !== "owner");
  expect(memberOps.map((op) => op.name)).toEqual([]);
});
