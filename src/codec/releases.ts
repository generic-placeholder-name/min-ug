export interface CodecRelease {
  readonly id: number;
  readonly model: string;
  readonly entropyCoder: "arithmetic" | "rans";
  readonly abi: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly maximumCanonicalUrlBytes: number;
  readonly maximumPayloadBytes: number;
}

export const V1_RELEASE = Object.freeze({
  id: 1,
  model: "gru-l",
  entropyCoder: "arithmetic",
  abi: "codec-abi-v1",
  artifact: "codecs/artifacts/gru-l.wasm",
  sha256: "f5442634407f76cc28e7494a17343e84b0c96feb4d92170186dffd1d27d8c79b",
  maximumCanonicalUrlBytes: 511,
  maximumPayloadBytes: 2048
} satisfies CodecRelease);

export const CODEC_RELEASES = Object.freeze([V1_RELEASE] as const);
