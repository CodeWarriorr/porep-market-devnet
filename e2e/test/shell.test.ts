import assert from "node:assert/strict";
import test from "node:test";
import { commandInvocation, formatCommand } from "../src/shell.js";

test("cast runs in the exact Curio service with the internal Lotus RPC URL", () => {
  assert.deepEqual(
    commandInvocation("cast", [
      "code", "--rpc-url", "http://127.0.0.1:2234/rpc/v1",
      "0x1111111111111111111111111111111111111111",
    ]),
    {
      command: "docker",
      args: [
        "exec", "porep-market-curio-devnet-curio-1", "cast", "code",
        "--rpc-url", "http://lotus:1234/rpc/v1",
        "0x1111111111111111111111111111111111111111",
      ],
    },
  );
});

test("formatted failures redact private key arguments", () => {
  assert.equal(
    formatCommand("cast", ["send", "--private-key", `0x${"a".repeat(64)}`, "0x1"]),
    "cast send --private-key REDACTED 0x1",
  );
});
