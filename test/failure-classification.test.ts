import assert from "node:assert/strict";
import test from "node:test";

import { classifyDifference } from "../tools/bench/classify-failure.js";

test("classifies common URL round-trip differences", () => {
  assert.equal(classifyDifference("https://example.com/a", "https://example.com/a"), "exact");
  assert.equal(classifyDifference("https://example.com/a/", "https://example.com/a"), "trailing-slash");
  assert.equal(classifyDifference("https://example.com/%2f", "https://example.com/%2F"), "escape-case");
  assert.equal(classifyDifference("https://example.com/?x=a%2Bb", "https://example.com/?x=a+b"), "plus-percent-2b");
  assert.equal(classifyDifference("https://example.com/path?", "https://example.com/path"), "bare-query-or-fragment");
  assert.equal(classifyDifference("https://example.com/?flag", "https://example.com/?flag="), "valueless-parameter");
  assert.equal(classifyDifference("https://example.com/a//b", "https://example.com/a/b"), "path-slash-normalization");
  assert.equal(classifyDifference("https://example.com/?x=1", "https://example.com/?x=2"), "query-changed");
});
