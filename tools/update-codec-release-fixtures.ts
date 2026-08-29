import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateV1Fixtures, V1_FIXTURE_PATH } from "./lib/codec-release-fixtures.js";
import { writeJsonAtomic } from "./lib/files.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
await writeJsonAtomic(
  resolve(repository, V1_FIXTURE_PATH),
  await generateV1Fixtures(repository)
);
console.log(`updated ${V1_FIXTURE_PATH}`);
