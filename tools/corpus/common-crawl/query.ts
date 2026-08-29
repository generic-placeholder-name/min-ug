import type { CommonCrawlSourceManifest } from "./types.js";

function sqlString (value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function identifier (value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Unsafe Athena identifier ${JSON.stringify(value)}`);
  }
  return value;
}

function list (values: readonly (string | number)[]): string {
  return values.map(value => typeof value === "number" ? String(value) : sqlString(value)).join(", ");
}

function tableName (source: CommonCrawlSourceManifest): string {
  return `${identifier(source.index.database)}.${identifier(source.index.table)}`;
}

function eligibleWhere (source: CommonCrawlSourceManifest): string {
  return `crawl = ${sqlString(source.crawl)}
    AND subset = 'warc'
    AND url_protocol IN (${list(source.sampling.protocols)})
    AND fetch_status IN (${list(source.sampling.statuses)})
    AND coalesce(content_mime_detected, content_mime_type) IN (${list(source.sampling.mimeTypes)})
    AND url IS NOT NULL
    AND url_host_name IS NOT NULL`;
}

export function createTableSql (source: CommonCrawlSourceManifest): string {
  return `CREATE EXTERNAL TABLE IF NOT EXISTS ${tableName(source)} (
    url_surtkey STRING,
    url STRING,
    url_host_name STRING,
    url_host_tld STRING,
    url_host_2nd_last_part STRING,
    url_host_3rd_last_part STRING,
    url_host_4th_last_part STRING,
    url_host_5th_last_part STRING,
    url_host_registry_suffix STRING,
    url_host_registered_domain STRING,
    url_host_private_suffix STRING,
    url_host_private_domain STRING,
    url_host_name_reversed STRING,
    url_protocol STRING,
    url_port INT,
    url_path STRING,
    url_query STRING,
    fetch_time TIMESTAMP,
    fetch_status SMALLINT,
    fetch_redirect STRING,
    content_digest STRING,
    content_mime_type STRING,
    content_mime_detected STRING,
    content_charset STRING,
    content_languages STRING,
    content_truncated STRING,
    warc_filename STRING,
    warc_record_offset INT,
    warc_record_length INT,
    warc_segment STRING
  ) PARTITIONED BY (crawl STRING, subset STRING)
  STORED AS PARQUET
  LOCATION ${sqlString(source.index.location)}`;
}

export function addPartitionSql (source: CommonCrawlSourceManifest): string {
  const location = `${source.index.location.replace(/\/+$/u, "")}/crawl=${source.crawl}/subset=warc/`;
  return `ALTER TABLE ${tableName(source)} ADD IF NOT EXISTS
    PARTITION (crawl = ${sqlString(source.crawl)}, subset = 'warc')
    LOCATION ${sqlString(location)}`;
}

export function eligibleCountSql (source: CommonCrawlSourceManifest): string {
  return `SELECT count(*) AS eligible_rows
  FROM ${tableName(source)}
  WHERE ${eligibleWhere(source)}`;
}

export function hashBucketExpression (source: CommonCrawlSourceManifest): string {
  const seed = sqlString(
    `${source.sampling.seed.length}:${source.sampling.seed}9:candidate`
  );
  return `mod(
    bitwise_and(
      from_big_endian_64(xxhash64(to_utf8(concat(${seed}, url)))),
      2147483647
    ),
    ${source.sampling.hashBuckets}
  )`;
}

export function candidateUnloadSql (
  source: CommonCrawlSourceManifest,
  bucketStart: number,
  bucketEnd: number,
  output: string
): string {
  if (
    !Number.isInteger(bucketStart) || !Number.isInteger(bucketEnd) ||
    bucketStart < 0 || bucketEnd <= bucketStart || bucketEnd > source.sampling.hashBuckets
  ) throw new Error("Invalid Common Crawl hash bucket range");
  const bucket = hashBucketExpression(source);
  return `UNLOAD (
    SELECT url
    FROM ${tableName(source)}
    WHERE ${eligibleWhere(source)}
      AND ${bucket} >= ${bucketStart}
      AND ${bucket} < ${bucketEnd}
  ) TO ${sqlString(output)}
  WITH (format = 'PARQUET', compression = 'ZSTD')`;
}

export function candidateBucketWidth (
  source: CommonCrawlSourceManifest,
  requestedUrls: number,
  eligibleRows: number
): number {
  if (!Number.isSafeInteger(requestedUrls) || requestedUrls <= 0) {
    throw new Error("Requested URL count must be a positive safe integer");
  }
  if (!Number.isSafeInteger(eligibleRows) || eligibleRows < requestedUrls) {
    throw new Error(`Common Crawl has only ${eligibleRows} eligible rows for ${requestedUrls} URLs`);
  }
  return Math.max(1, Math.ceil(
    requestedUrls * source.sampling.candidateMultiplier /
    eligibleRows * source.sampling.hashBuckets
  ));
}
