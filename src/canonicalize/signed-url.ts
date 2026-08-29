const awsV4CompanionParameters = Object.freeze([
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-signedheaders"
]);

const googleV4CompanionParameters = Object.freeze([
  "x-goog-algorithm",
  "x-goog-credential",
  "x-goog-date",
  "x-goog-expires",
  "x-goog-signedheaders"
]);

const azureSasCompanionParameters = Object.freeze([
  "se",
  "si",
  "skoid",
  "sp",
  "sr",
  "srt",
  "ss"
]);

const azureStorageHostSuffixes = Object.freeze([
  ".core.windows.net",
  ".core.usgovcloudapi.net",
  ".core.chinacloudapi.cn",
  ".core.cloudapi.de"
]);

const cloudinarySignatureSegment = /(?:^|\/)s--[A-Za-z0-9_-]{8}--(?:\/|$)/;
const googleMapsSignedPath = /^\/maps\/api\/(?:staticmap|streetview)(?:\/|$)/;
const supabaseSignedStoragePath =
  /^\/storage\/v1\/(?:object\/sign|render\/image\/sign)(?:\/|$)/;
const unreservedCharacter = /^[A-Za-z0-9._~-]$/u;

function hasAll (names: ReadonlySet<string>, required: readonly string[]): boolean {
  return required.every(name => names.has(name));
}

function hasAny (names: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some(name => names.has(name));
}

function isAzureStorageHost (hostname: string): boolean {
  return azureStorageHostSuffixes.some(suffix => hostname.endsWith(suffix));
}

function decodeUnreservedPathEscapes (pathname: string): string {
  return pathname.replace(/%([0-9A-Fa-f]{2})/gu, (escape: string, hexadecimal: string) => {
    const character = String.fromCharCode(Number.parseInt(hexadecimal, 16));
    return unreservedCharacter.test(character) ? character : escape;
  });
}

/**
 * A generic `sig` or `token` check would suppress cleaning for many ordinary URLs. Compound,
 * provider-specific signals keep false positives narrower while protecting known signing forms.
 *
 * Format references:
 * - AWS SigV4: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html
 * - Google Cloud Storage: https://cloud.google.com/storage/docs/access-control/signed-urls
 * - Azure Storage SAS: https://learn.microsoft.com/rest/api/storageservices/create-service-sas
 * - CloudFront: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html
 * - Cloudinary: https://cloudinary.com/documentation/delivery_url_signatures
 * - Google Maps Platform: https://developers.google.com/maps/digital-signature
 * - Supabase Storage: https://supabase.com/docs/guides/storage/serving/downloads
 */
export function detectProbableSignedUrlScheme (url: URL): string | undefined {
  const names = new Set([...url.searchParams.keys()].map(name => name.toLowerCase()));
  // Aggressive RFC normalization decodes unreserved path escapes, so preflight must match the
  // same spelling equivalence before any optional transform is allowed to run.
  const recognizablePath = decodeUnreservedPathEscapes(url.pathname);

  // Cloudinary puts an eight-character URL-safe digest in a distinctive path segment. Match
  // the format rather than its default host because Cloudinary supports custom delivery hosts.
  if (cloudinarySignatureSegment.test(recognizablePath)) {
    return "Cloudinary delivery URL signing";
  }

  if (
    url.hostname === "maps.googleapis.com" &&
    googleMapsSignedPath.test(recognizablePath) &&
    names.has("signature") &&
    hasAny(names, ["key", "client"])
  ) {
    return "Google Maps Platform URL signing";
  }

  // The endpoint path is provider-specific enough to cover hosted, custom-domain, and
  // self-hosted Supabase deployments without treating a generic `token` as a signature.
  if (supabaseSignedStoragePath.test(recognizablePath) && names.has("token")) {
    return "Supabase Storage signed URL";
  }

  // Namespaced parameters work on AWS hosts, S3-compatible services, and some custom endpoints.
  if (names.has("x-amz-signature") && hasAny(names, awsV4CompanionParameters)) {
    return "AWS Signature Version 4";
  }
  if (names.has("x-goog-signature") && hasAny(names, googleV4CompanionParameters)) {
    return "Google Cloud Storage V4 signing";
  }

  // CloudFront signed URLs may use an arbitrary alternate domain, so match the full bundle.
  if (
    hasAll(names, ["signature", "key-pair-id"]) &&
    hasAny(names, ["expires", "policy"])
  ) {
    return "Amazon CloudFront signing";
  }

  // Older S3 and Google Storage formats use generic Signature/Expires names, made distinctive
  // by their provider-specific access-key parameter.
  if (hasAll(names, ["awsaccesskeyid", "expires", "signature"])) {
    return "Amazon S3 Signature Version 2";
  }
  if (hasAll(names, ["googleaccessid", "expires", "signature"])) {
    return "Google Cloud Storage V2 signing";
  }

  // Modern Azure SAS URLs carry `sv`; the host fallback covers documented legacy SAS forms.
  if (
    names.has("sig") &&
    hasAny(names, azureSasCompanionParameters) &&
    (names.has("sv") || isAzureStorageHost(url.hostname))
  ) {
    return "Azure Storage shared access signature";
  }

  return undefined;
}
