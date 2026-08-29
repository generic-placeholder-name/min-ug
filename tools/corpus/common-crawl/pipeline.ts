import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpus } from "node:os";
import { access, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "../../lib/files.js";
import { buildTrainingPack } from "../core/pack.js";
import { InsufficientCandidatesError, materializeCorpus } from "../core/materialize.js";
import { stageCandidates } from "../core/stage.js";
import { removeSafePath, StorageGuard } from "../core/storage.js";
import type { CandidateFile } from "../core/types.js";
import { verifyCorpus, verifyTrainingPack } from "../core/verify.js";
import { acquisitionCandidates, AthenaSampler } from "./athena.js";
import { candidateFormat } from "./manifest.js";
import type {
  AcquisitionManifest,
  CommonCrawlPipelineOptions
} from "./types.js";

async function exists (path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class CommonCrawlPipeline {
  readonly storage: StorageGuard;

  constructor (readonly options: CommonCrawlPipelineOptions) {
    this.storage = new StorageGuard(
      [
        options.paths.workDirectory,
        options.paths.corpusDirectory,
        options.paths.packDirectory
      ],
      options.storageBudgetBytes,
      options.minimumFreeBytes
    );
  }

  async initialize (): Promise<void> {
    await Promise.all([
      mkdir(this.options.paths.workDirectory, { recursive: true }),
      mkdir(this.options.paths.corpusDirectory, { recursive: true }),
      mkdir(dirname(this.options.paths.packDirectory), { recursive: true })
    ]);
    await this.storage.assertWithinBudget("pipeline startup");
  }

  private sampler (): AthenaSampler {
    if (this.options.athenaOutput === undefined) {
      throw new Error("--athena-output is required unless --candidate-file is supplied");
    }
    return new AthenaSampler({
      source: this.options.source,
      sourceManifestSha256: this.options.sourceManifestSha256,
      requestedUrls: this.options.requestedUrls,
      athenaOutput: this.options.athenaOutput,
      localDirectory: this.options.paths.candidateDirectory,
      manifestPath: this.options.paths.acquisitionManifestPath,
      region: this.options.awsRegion,
      ...(this.options.athenaWorkgroup === undefined
        ? {}
        : { workgroup: this.options.athenaWorkgroup })
    });
  }

  private async localCandidates (): Promise<CandidateFile[]> {
    const candidates: CandidateFile[] = [];
    for (const input of this.options.candidateFiles) {
      const path = resolve(input);
      const metadata = await stat(path);
      candidates.push({
        path,
        format: candidateFormat(path),
        bytes: metadata.size,
        sha256: await sha256File(path)
      });
    }
    return candidates;
  }

  private async initialCandidates (): Promise<{
    candidates: CandidateFile[];
    acquisition?: AcquisitionManifest;
  }> {
    if (this.options.candidateFiles.length > 0) {
      return { candidates: await this.localCandidates() };
    }
    const acquisition = await this.sampler().acquireInitial();
    return { candidates: acquisitionCandidates(acquisition), acquisition };
  }

  private async stage (candidates: readonly CandidateFile[], force: boolean): Promise<void> {
    await stageCandidates({
      candidates,
      sourceManifestSha256: this.options.sourceManifestSha256,
      outputDirectory: this.options.paths.stagingDirectory,
      manifestPath: this.options.paths.stagingManifestPath,
      workDirectory: this.options.paths.workDirectory,
      seed: this.options.source.sampling.seed,
      requestedUrls: this.options.requestedUrls,
      shardCount: this.options.stagingShards,
      threads: this.options.threads,
      canonicalizerWorkers: this.options.canonicalizerWorkers,
      storageGuard: this.storage,
      force
    });
  }

  async materialize (force = this.options.force): Promise<void> {
    await materializeCorpus({
      stagingDirectory: this.options.paths.stagingDirectory,
      stagingManifestPath: this.options.paths.stagingManifestPath,
      outputDirectory: this.options.paths.corpusDirectory,
      manifestPath: this.options.paths.corpusManifestPath,
      workDirectory: this.options.paths.workDirectory,
      corpusId: this.options.source.id,
      sourceManifestSha256: this.options.sourceManifestSha256,
      crawl: this.options.source.crawl,
      samplingProfile: this.options.source.sampling.profile,
      requestedUrls: this.options.requestedUrls,
      hostBalancedFraction: this.options.source.sampling.hostBalancedFraction,
      maximumUrlsPerHost: this.options.source.sampling.maximumUrlsPerHost,
      candidateMultiplier: this.options.source.sampling.candidateMultiplier,
      seed: this.options.source.sampling.seed,
      validationFraction: this.options.validationFraction,
      testFraction: this.options.testFraction,
      threads: this.options.threads,
      memoryLimit: this.options.duckdbMemory,
      maximumTemporaryDirectorySize: this.options.maximumTemporaryDirectorySize,
      storageGuard: this.storage,
      force
    });
  }

  async pack (): Promise<void> {
    await buildTrainingPack({
      corpusDirectory: this.options.paths.corpusDirectory,
      corpusManifestPath: this.options.paths.corpusManifestPath,
      outputDirectory: this.options.paths.packDirectory,
      targetShardBytes: this.options.targetShardBytes,
      threads: this.options.threads,
      force: this.options.force
    });
  }

  async verify (): Promise<void> {
    await verifyCorpus(
      this.options.paths.corpusDirectory,
      this.options.paths.corpusManifestPath,
      this.options.threads
    );
    if (await exists(this.options.paths.packManifestPath)) {
      await verifyTrainingPack(
        this.options.paths.packDirectory,
        this.options.paths.packManifestPath,
        this.options.paths.corpusManifestPath
      );
    }
  }

  private async benchmark (): Promise<void> {
    const python = process.platform === "win32" ? "python" : "python3";
    const reportPath = resolve(this.options.paths.workDirectory, "loader-benchmark.json");
    const child = spawn(python, [
      "-m",
      "training.loader_benchmark",
      "--manifest",
      this.options.paths.packManifestPath,
      "--report",
      reportPath
    ], {
      stdio: "inherit",
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../../")
    });
    const [code] = await once(child, "exit") as [number | null];
    if (code !== 0) throw new Error(`PyTorch loader benchmark exited with code ${code}`);
  }

  async sample (): Promise<void> {
    if (!this.options.force) {
      try {
        const existing = await verifyCorpus(
          this.options.paths.corpusDirectory,
          this.options.paths.corpusManifestPath,
          this.options.threads
        );
        if (existing.sampling.requestedUrls === this.options.requestedUrls) {
          console.log("corpus: existing Common Crawl sample is verified");
          return;
        }
      } catch {
        // Resume from candidate acquisition below.
      }
    }

    let { candidates, acquisition } = await this.initialCandidates();
    let topUp = false;
    for (;;) {
      await this.stage(candidates, this.options.force || topUp);
      try {
        await this.materialize(this.options.force || topUp);
        break;
      } catch (error) {
        if (!(error instanceof InsufficientCandidatesError) || acquisition === undefined) throw error;
        console.log(`${error.message}; acquiring the next deterministic hash range`);
        acquisition = await this.sampler().acquireNext(acquisition);
        candidates = acquisitionCandidates(acquisition);
        topUp = true;
      }
    }
    await verifyCorpus(
      this.options.paths.corpusDirectory,
      this.options.paths.corpusManifestPath,
      this.options.threads
    );
    if (this.options.compact) {
      await removeSafePath(this.options.paths.workDirectory, this.options.paths.stagingDirectory);
      if (acquisition !== undefined) {
        await removeSafePath(this.options.paths.workDirectory, this.options.paths.candidateDirectory);
      }
    }
  }

  async all (): Promise<void> {
    await this.sample();
    if (this.options.keepPack || this.options.benchmarkLoader) {
      await this.pack();
      await verifyTrainingPack(
        this.options.paths.packDirectory,
        this.options.paths.packManifestPath,
        this.options.paths.corpusManifestPath
      );
      if (this.options.benchmarkLoader) await this.benchmark();
      if (this.options.benchmarkLoader && !this.options.keepPack) {
        await removeSafePath(resolve(this.options.paths.packDirectory, ".."), this.options.paths.packDirectory);
        console.log("pack: removed temporary training pack after benchmark");
      }
    }
  }
}

export function defaultWorkerCount (): number {
  return Math.max(1, cpus().length - 2);
}
