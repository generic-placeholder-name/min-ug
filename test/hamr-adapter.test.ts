import assert from "node:assert/strict";
import test from "node:test";

import {
  createHamrBaseline,
  verifyHamrVendor
} from "../tools/baselines/hamr.js";

test("ha.mr comparison baseline is intact and executable", async () => {
  const metadata = await verifyHamrVendor();
  assert.equal(metadata.revision, "ac46e7c8da33eca16528776f5ce79f1f0a661f0a");
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  for (const alphabet of ["ascii", "qr"]) {
    const codec = createHamrBaseline({ alphabet });
    const payload = codec.encode(url);
    assert.equal(codec.decode(payload), url);
  }
});
