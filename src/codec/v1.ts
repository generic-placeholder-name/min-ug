import { createVersionedFragmentCodec, type VersionedFragmentCodec } from "./fragment.js";
import { V1_RELEASE } from "./releases.js";
import {
  instantiateWasmCodec,
  type WasmCodecLimits,
  type WasmSource
} from "./wasm-adapter.js";

export async function instantiateV1Codec (
  source: WasmSource,
  limits: WasmCodecLimits = {}
): Promise<VersionedFragmentCodec> {
  const codec = await instantiateWasmCodec(source, {
    maxCanonicalUrlBytes: limits.maxCanonicalUrlBytes ?? V1_RELEASE.maximumCanonicalUrlBytes,
    maxPayloadBytes: limits.maxPayloadBytes ?? V1_RELEASE.maximumPayloadBytes,
    ...(limits.maxMemoryBytes === undefined ? {} : { maxMemoryBytes: limits.maxMemoryBytes })
  });
  return createVersionedFragmentCodec(
    new Map([[V1_RELEASE.id, codec]]),
    V1_RELEASE.id,
    {
      maximumPayloadBytes: limits.maxPayloadBytes ?? V1_RELEASE.maximumPayloadBytes,
      maximumCanonicalUrlBytes:
        limits.maxCanonicalUrlBytes ?? V1_RELEASE.maximumCanonicalUrlBytes,
      maximumRenderedCharacters: Math.ceil(
        ((limits.maxPayloadBytes ?? V1_RELEASE.maximumPayloadBytes) * 8 + 64) /
        Math.log2(81)
      )
    }
  );
}
