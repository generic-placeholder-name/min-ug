const uuidPattern = /(?:^|[^0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:$|[^0-9a-f])/iu;
const hashPattern = /(?:^|[^0-9a-f])(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})(?:$|[^0-9a-f])/iu;
const opaquePattern = /(?:^|[/?#=&])(?:[A-Za-z0-9_-]{20,}|[0-9a-f]{16,})(?:$|[/?#=&])/u;

export interface UrlClassificationContext {
  readonly tags?: readonly string[];
  readonly hostCount?: number | undefined;
  readonly popularHost?: boolean;
  readonly adversarial?: boolean;
}

function containsWrappedUrl (url: URL): boolean {
  for (const [, value] of url.searchParams) {
    const candidates = [value];
    try {
      candidates.push(decodeURIComponent(value));
    } catch {
      // A malformed value is still valid corpus input, just not a nested URL candidate.
    }
    if (candidates.some(candidate => /^https?:\/\//iu.test(candidate))) return true;
  }
  return false;
}

export function classifyUrl (
  urlString: string,
  context: UrlClassificationContext = {}
): string[] {
  const url = new URL(urlString);
  const classes = new Set(context.tags ?? []);
  const segments = url.pathname.split("/").filter(Boolean);
  const hasOpaqueId = opaquePattern.test(`${url.pathname}${url.search}${url.hash}`);

  if (uuidPattern.test(urlString) || hashPattern.test(urlString)) classes.add("uuid-or-hash-bearing");
  if (containsWrappedUrl(url)) classes.add("wrapped");
  if (url.searchParams.size >= 4 || url.search.length >= 100) classes.add("query-heavy");
  if (context.hostCount === 1) classes.add("unknown-host");
  if (hasOpaqueId) classes.add("opaque-id");

  if (context.popularHost) {
    classes.add("popular-host");
    if (hasOpaqueId) classes.add("popular-host-opaque-id");
    if (segments.length <= 2 && !hasOpaqueId) classes.add("popular-host-short-path");
  }

  if (context.adversarial) classes.add("adversarial");
  return [...classes].sort();
}
