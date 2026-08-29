import type { CandidateFile, CorpusPaths } from "../core/types.js";

export interface CommonCrawlSourceManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly crawl: string;
  readonly description: string;
  readonly index: {
    readonly database: string;
    readonly table: string;
    readonly location: string;
  };
  readonly sampling: {
    readonly profile: "balanced-v1";
    readonly seed: string;
    readonly candidateMultiplier: number;
    readonly hostBalancedFraction: number;
    readonly maximumUrlsPerHost: number;
    readonly hashBuckets: number;
    readonly protocols: readonly ("http" | "https")[];
    readonly statuses: readonly number[];
    readonly mimeTypes: readonly string[];
  };
}

export interface AcquisitionRound {
  readonly index: number;
  readonly bucketStart: number;
  readonly bucketEnd: number;
  readonly remotePrefix: string;
  readonly queryExecutionId: string;
  readonly files: readonly CandidateFile[];
}

export interface AcquisitionManifest {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly sourceManifestSha256: string;
  readonly requestedUrls: number;
  readonly eligibleRows: number;
  readonly athenaOutput: string;
  readonly rounds: readonly AcquisitionRound[];
}

export interface CommonCrawlPipelineOptions {
  readonly sourceManifestPath: string;
  readonly sourceManifestSha256: string;
  readonly source: CommonCrawlSourceManifest;
  readonly paths: CorpusPaths;
  readonly requestedUrls: number;
  readonly validationFraction: number;
  readonly testFraction: number;
  readonly threads: number;
  readonly canonicalizerWorkers: number;
  readonly duckdbMemory: string;
  readonly maximumTemporaryDirectorySize: string;
  readonly storageBudgetBytes: number;
  readonly minimumFreeBytes: number;
  readonly targetShardBytes: number;
  readonly stagingShards: number;
  readonly compact: boolean;
  readonly keepPack: boolean;
  readonly benchmarkLoader: boolean;
  readonly force: boolean;
  readonly candidateFiles: readonly string[];
  readonly athenaOutput?: string;
  readonly athenaWorkgroup?: string;
  readonly awsRegion: string;
}
