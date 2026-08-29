import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CODEC_RELEASES } from "../src/codec/releases.js";
import { verifyV1Fixtures } from "./lib/codec-release-fixtures.js";
import { verifyCodecReleases } from "./lib/codec-releases.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
await verifyCodecReleases(repository);
await verifyV1Fixtures(repository);

for (const release of CODEC_RELEASES) {
  console.log(`codec ${release.id}: ${release.model} ${release.sha256}`);
}
