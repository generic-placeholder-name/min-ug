import { resolve } from "node:path";

import { CODEC_RELEASES, type CodecRelease } from "../../src/codec/releases.js";
import { sha256File } from "./files.js";

export function assertReleaseChecksum (release: CodecRelease, actual: string): void {
  if (actual !== release.sha256) {
    throw new Error(
      `Released codec ${release.id} (${release.model}) is immutable: ` +
      `expected SHA-256 ${release.sha256}, received ${actual}`
    );
  }
}

export async function verifyCodecReleases (repository: string): Promise<void> {
  for (const release of CODEC_RELEASES) {
    const actual = await sha256File(resolve(repository, release.artifact));
    assertReleaseChecksum(release, actual);
  }
}

