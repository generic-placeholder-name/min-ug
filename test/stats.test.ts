import assert from "node:assert/strict";
import test from "node:test";

import { describe, percentile } from "../tools/bench/stats.js";

test("percentile interpolates and describe reports long-tail metrics", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.deepEqual(describe([1, 2, 3, 4]), {
    count: 4,
    min: 1,
    max: 4,
    mean: 2.5,
    median: 2.5,
    p50: 2.5,
    p95: 3.8499999999999996,
    p99: 3.9699999999999998
  });
  assert.equal(describe([]), null);
});

