import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManagerPointer,
  assertRequiredManagerRole,
} from "../src/scenarios/accessManagerLifecycle.js";

test("AccessManager topology checks reject a target bound to another manager", () => {
  assert.throws(
    () => assertManagerPointer("0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "SLIOracle"),
    /SLIOracle access manager/,
  );
});

test("AccessManager topology checks reject a missing required role", () => {
  assert.throws(
    () => assertRequiredManagerRole(false, "oracle", "ORACLE_ROLE"),
    /oracle lacks ORACLE_ROLE/,
  );
});
