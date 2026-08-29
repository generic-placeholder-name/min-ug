# Common Crawl corpus artifacts

## Sampling contract

`--count N` requests exactly `N` distinct Clean-canonical URLs in the final corpus. The source
manifest pins the crawl, filters, seed, hash space, candidate multiplier, hostname cap, and
sampling profile. Athena evaluates the URL Index in `us-east-1` and unloads only deterministic
hash ranges to a user-owned S3 prefix.

The first candidate range targets twice the requested URL count. Candidates are canonicalized
and deduplicated locally. If fewer than `N` survive, the next disjoint hash range is acquired and
the build repeats. A completed manifest records every query execution, bucket range, remote URI,
local byte count, and SHA-256.

The `balanced-v1` selector uses 80% of its quota for hostname coverage, capped at 16 URLs per
hostname, then fills the remaining quota with a URL-uniform deterministic ordering. These are
sampling choices, not claims about real user traffic.

## Durable corpus

Parquet stores one row per selected URL:

| Column | Type | Meaning |
| --- | --- | --- |
| `url` | `VARCHAR` | Unique Clean-canonical URL |
| `split` | `UTINYINT` | Five-way `CorpusSplit` value |

The split encoding is versioned:

| Value | Name | Meaning |
| ---: | --- | --- |
| 0 | `Train` | Training URL on a training hostname |
| 1 | `SeenHostValidation` | Validation URL on a training hostname |
| 2 | `SeenHostTest` | Test URL on a training hostname |
| 3 | `UnseenHostValidation` | URL on a validation-only hostname |
| 4 | `UnseenHostTest` | URL on a test-only hostname |

Hostname and within-host assignments use deterministic 80/10/10 hashes after canonicalization.
A training hostname used for seen-host evaluation is repaired deterministically when necessary
so it retains at least one training URL.

Candidate, rejection, duplicate, host, and split counts belong to the corpus manifest. There are
no per-row crawl-frequency or referring-page columns because a sampled crawl does not provide a
defensible user-frequency signal.

## Temporary training pack

| Suffix | Record layout |
| --- | --- |
| `.bytes` | Concatenated UTF-8 URLs |
| `.offsets` | `N + 1` little-endian `uint32` byte offsets |
| `.splits` | One versioned `CorpusSplit` byte per URL |

The pack writer starts a new shard before the byte payload reaches its configured target or the
4 GiB offset limit. The pack manifest binds every file to the SHA-256 of the corpus manifest.

## Verification and recovery

`verify` checks file hashes, Parquet schema, exact row count, URL uniqueness, split range and
counts, hostname isolation, seen-host training coverage, pack offsets, and every pack split byte.
The compact workflow removes local candidate exports and staging only after this verification.
Remote Athena exports are retained because deleting user-owned S3 objects is outside the corpus
builder's default authority.
