import assert from "node:assert/strict";
import test from "node:test";
import { randomCarArgs } from "../src/devnet/piece.js";

test("full-sector stress pieces request a raw CAR that pads to the 8 MiB sector", () => {
  assert.deepEqual(randomCarArgs("/tmp/piece", 3_500_000), [
    "sptool", "toolbox", "mk12-client", "generate-rand-car",
    "--size", "3500000", "/tmp/piece",
  ]);
});

test("piece generation rejects unsafe raw sizes", () => {
  assert.throws(() => randomCarArgs("/tmp/piece", 0), /positive safe integer/);
});
