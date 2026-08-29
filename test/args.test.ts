import assert from "node:assert/strict";
import test from "node:test";

import { booleanArg, numberArg, parseArgs } from "../tools/lib/args.js";

test("parseArgs handles positional, repeated, assigned, and boolean arguments", () => {
  assert.deepEqual(
    parseArgs(["prepare", "--input", "a=one.txt", "--input=b=two.txt", "--force"]),
    { _: ["prepare"], input: ["a=one.txt", "b=two.txt"], force: true }
  );
});

test("numberArg and booleanArg validate values", () => {
  assert.equal(numberArg({ count: "4" }, "count", 2, { minimum: 1 }), 4);
  assert.equal(booleanArg({ enabled: "false" }, "enabled", true), false);
  assert.throws(() => numberArg({ count: "zero" }, "count", 2), /must be a number/u);
  assert.throws(() => booleanArg({ enabled: "sometimes" }, "enabled"), /true or false/u);
});

