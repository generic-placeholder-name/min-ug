export const CorpusSplit = {
  Train: 0,
  SeenHostValidation: 1,
  SeenHostTest: 2,
  UnseenHostValidation: 3,
  UnseenHostTest: 4
} as const;

export type CorpusSplit = typeof CorpusSplit[keyof typeof CorpusSplit];

export const corpusSplitNames = [
  "train",
  "seenHostValidation",
  "seenHostTest",
  "unseenHostValidation",
  "unseenHostTest"
] as const;

export type CorpusSplitName = typeof corpusSplitNames[number];

export type SplitCounts = Record<CorpusSplitName, number>;

export interface FileMetadata {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CandidateFile extends FileMetadata {
  readonly format: "parquet" | "jsonl" | "jsonl-gzip" | "text" | "text-gzip";
  readonly remoteUri?: string;
}

export interface RejectionSample {
  readonly ordinal: number;
  readonly code: string;
  readonly detail: string;
}

export interface StagingShard extends FileMetadata {
  readonly index: number;
  readonly records: number;
}

export interface StagingManifest {
  readonly schemaVersion: 2;
  readonly createdAt: string;
  readonly sourceManifestSha256: string;
  readonly canonicalizerSha256: string;
  readonly seed: string;
  readonly requestedUrls: number;
  readonly shardCount: number;
  readonly candidates: readonly CandidateFile[];
  readonly counts: {
    readonly candidates: number;
    readonly accepted: number;
    readonly rejected: number;
  };
  readonly rejectionCounts: Readonly<Record<string, number>>;
  readonly rejectionSample: readonly RejectionSample[];
  readonly shards: readonly StagingShard[];
}

export interface CorpusShard extends FileMetadata {
  readonly index: number;
  readonly records: number;
}

export interface CorpusManifest {
  readonly schemaVersion: 2;
  readonly createdAt: string;
  readonly format: "canonical-url-split-v1";
  readonly corpusId: string;
  readonly source: {
    readonly kind: "common-crawl-url-index";
    readonly manifestSha256: string;
    readonly crawl: string;
    readonly samplingProfile: string;
  };
  readonly canonicalization: {
    readonly preset: "clean";
    readonly sourceSha256: string;
  };
  readonly sampling: {
    readonly requestedUrls: number;
    readonly hostBalancedFraction: number;
    readonly maximumUrlsPerHost: number;
    readonly candidateMultiplier: number;
  };
  readonly seed: string;
  readonly validationFraction: number;
  readonly testFraction: number;
  readonly duckdb: {
    readonly version: string;
    readonly threads: number;
    readonly memoryLimit: string;
    readonly maximumTemporaryDirectorySize: string;
    readonly parquetCompression: "zstd";
    readonly parquetCompressionLevel: 1;
    readonly parquetRowGroupSize: 250000;
  };
  readonly counts: {
    readonly candidateRows: number;
    readonly acceptedBeforeDedupe: number;
    readonly uniqueBeforeSelection: number;
    readonly duplicateRows: number;
    readonly finalUrls: number;
    readonly distinctHosts: number;
  };
  readonly splits: SplitCounts;
  readonly stagingManifestSha256: string;
  readonly shards: readonly CorpusShard[];
}

export interface TrainingPackShard {
  readonly index: number;
  readonly records: number;
  readonly urlBytes: number;
  readonly files: {
    readonly bytes: FileMetadata;
    readonly offsets: FileMetadata;
    readonly splits: FileMetadata;
  };
}

export interface TrainingPackManifest {
  readonly schemaVersion: 2;
  readonly createdAt: string;
  readonly format: "utf8-url-split-v2";
  readonly byteOrder: "little-endian";
  readonly splitEncoding: Readonly<Record<CorpusSplitName, CorpusSplit>>;
  readonly corpusManifestSha256: string;
  readonly counts: {
    readonly records: number;
    readonly urlBytes: number;
  };
  readonly shards: readonly TrainingPackShard[];
}

export interface CorpusPaths {
  readonly workDirectory: string;
  readonly candidateDirectory: string;
  readonly acquisitionManifestPath: string;
  readonly stagingDirectory: string;
  readonly stagingManifestPath: string;
  readonly corpusDirectory: string;
  readonly corpusManifestPath: string;
  readonly packDirectory: string;
  readonly packManifestPath: string;
}
