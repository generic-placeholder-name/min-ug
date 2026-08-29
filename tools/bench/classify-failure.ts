function normalizeEscapeCase (value: string): string {
  return value.replace(/%[0-9a-f]{2}/giu, escape => escape.toUpperCase());
}

function safeUrl (value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function withoutUserInfo (url: URL): string {
  const clone = new URL(url.href);
  clone.username = "";
  clone.password = "";
  return clone.href;
}

function normalizeEmptyPathSegments (url: URL): string {
  const clone = new URL(url.href);
  const trailingSlash = clone.pathname.endsWith("/");
  const segments = clone.pathname.split("/").filter(Boolean);
  clone.pathname = segments.length === 0 ? "/" : `/${segments.join("/")}${trailingSlash ? "/" : ""}`;
  return clone.href;
}

function addEqualsToValuelessParameters (value: string): string {
  const queryStart = value.indexOf("?");
  if (queryStart === -1) return value;
  const fragmentStart = value.indexOf("#", queryStart);
  const end = fragmentStart === -1 ? value.length : fragmentStart;
  const query = value.slice(queryStart + 1, end);
  if (query.length === 0) return value;
  const normalized = query
    .split("&")
    .map(part => part.includes("=") ? part : `${part}=`)
    .join("&");
  return `${value.slice(0, queryStart + 1)}${normalized}${value.slice(end)}`;
}

export function classifyDifference (expected: string, actual: string): string {
  if (expected === actual) return "exact";

  if (
    (expected.endsWith("/") && expected.slice(0, -1) === actual) ||
    (actual.endsWith("/") && actual.slice(0, -1) === expected)
  ) return "trailing-slash";

  if (normalizeEscapeCase(expected) === normalizeEscapeCase(actual)) return "escape-case";

  const expectedPlus = expected.replace(/%2b/giu, "+");
  const actualPlus = actual.replace(/%2b/giu, "+");
  if (expectedPlus === actualPlus) return "plus-percent-2b";

  if (
    (expected.endsWith("?") || expected.endsWith("#")) &&
    expected.slice(0, -1) === actual
  ) return "bare-query-or-fragment";

  if (addEqualsToValuelessParameters(expected) === actual) return "valueless-parameter";

  const expectedUrl = safeUrl(expected);
  const actualUrl = safeUrl(actual);
  if (expectedUrl && actualUrl) {
    if ((expectedUrl.username || expectedUrl.password) && withoutUserInfo(expectedUrl) === actualUrl.href) {
      return "userinfo-dropped";
    }
    if (normalizeEmptyPathSegments(expectedUrl) === normalizeEmptyPathSegments(actualUrl)) {
      return "path-slash-normalization";
    }
    if (
      expectedUrl.origin === actualUrl.origin &&
      expectedUrl.pathname === actualUrl.pathname &&
      expectedUrl.hash === actualUrl.hash &&
      expectedUrl.search !== actualUrl.search
    ) return "query-changed";
  }

  return "other";
}
