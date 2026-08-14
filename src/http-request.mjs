import { createHash, createHmac } from "node:crypto";

const SENSITIVE_HEADER = /^(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-amz-security-token)$/i;
const SENSITIVE_NAME = /(?:auth|token|secret|password|passwd|api[-_]?key|credential|session|signature|sig)/i;
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SAFE_QUERY_NAMES = new Set(["cursor", "fields", "filter", "format", "id", "include", "lang", "limit", "locale", "offset", "order", "page", "q", "query", "search", "sort", "version"]);
const SAFE_HEADER_NAMES = new Set(["accept", "accept-encoding", "accept-language", "cache-control", "content-length", "content-type", "host", "if-modified-since", "if-none-match", "origin", "range", "referer", "transfer-encoding", "user-agent"]);
const SAFE_ROUTE_SEGMENTS = new Set(["account", "accounts", "admin", "api", "artifacts", "chat", "commits", "completions", "contents", "create", "delete", "download", "files", "graphql", "health", "issues", "list", "login", "logout", "metrics", "models", "oauth", "packages", "projects", "pulls", "raw", "releases", "remove", "repos", "repositories", "responses", "search", "status", "token", "update", "upload", "user", "users"]);
const PROTECTED_IDENTITY_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_ID_HEADERS = new Set([
  "x-amz-request-id",
  "x-amzn-requestid",
  "x-correlation-id",
  "x-request-id",
]);
const UUID_OR_HEX_REQUEST_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{16,64})$/i;
const TRACEPARENT = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i;
const B3_SINGLE = /^[\da-f]{16,32}-[\da-f]{16}(?:-[01d])?(?:-[\da-f]{16})?$/i;
const B3_TRACE_ID = /^[\da-f]{16}(?:[\da-f]{16})?$/i;
const B3_SPAN_ID = /^[\da-f]{16}$/i;

/**
 * Build a JSON-safe request summary without exposing header values, query
 * values, or raw body bytes outside this worker.
 */
export async function summarizeHttpRequest(request, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? 1_500;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const rawQueryNames = sortedUnique([...url.searchParams.keys()]);
  const rawHeaderNames = sortedUnique([...request.headers.keys()].map((name) => name.toLowerCase()));
  const queryParameterNames = sanitizeNames(rawQueryNames, SAFE_QUERY_NAMES);
  const headerNames = sanitizeNames(rawHeaderNames, SAFE_HEADER_NAMES, SENSITIVE_HEADER);
  const sensitiveQueryParameterNames = placeholders(rawQueryNames.filter((name) => SENSITIVE_NAME.test(name)), "SENSITIVE");
  const sensitiveHeaderNames = placeholders(rawHeaderNames.filter((name) => SENSITIVE_HEADER.test(name) || SENSITIVE_NAME.test(name)), "SENSITIVE");
  const declaredContentLength = parseContentLength(request.headers.get("content-length"));
  const contentType = safeContentType(request.headers.get("content-type"));
  const declaresBody = Boolean(request.headers.get("content-length") || request.headers.get("transfer-encoding"));
  const uninspectableBody = BODYLESS_METHODS.has(method) && declaresBody;
  const bodyPresent = uninspectableBody || request.body !== null;
  const body = uninspectableBody
    ? { bodyObservedBytes: 0, bodyComplete: false, bodyRiskFlags: ["uninspectable-bodyless-method"] }
    : request.body !== null
      ? await inspectBody(request.body, maxBodyBytes, bodyReadTimeoutMs)
      : {};
  return Object.freeze({
    method,
    origin: url.origin,
    path: sanitizePath(url.pathname),
    queryParameterNames,
    sensitiveQueryParameterNames,
    headerNames,
    sensitiveHeaderNames,
    ...(contentType ? { contentType } : {}),
    ...(declaredContentLength !== undefined ? { declaredContentLength } : {}),
    bodyPresent,
    ...body,
  });
}

export function isUninspectableHttpRequest(summary) {
  return summary.bodyRiskFlags?.includes("uninspectable-bodyless-method") === true;
}

/** Command-local opaque cache identity. It never enters reviewer prompts. */
export function httpRequestScopeFingerprint(request, summary, secret, options = {}) {
  const ignoredHeaders = normalizeIgnoredHttpHeaders(options.ignoredHeaders);
  const headers = [...request.headers.entries()]
    .map(([name, value]) => {
      const normalizedName = name.toLowerCase();
      return [
        normalizedName,
        ignoredHeaders.has(normalizedName)
          ? "[IGNORED]"
          : normalizeVolatileHeaderValue(normalizedName, value),
      ];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return createHmac("sha256", secret).update(JSON.stringify({
    method: request.method,
    url: request.url,
    headers,
    bodySha256: summary.bodySha256 ?? null,
  })).digest("hex");
}

/**
 * Validate header names which a caller may omit from the opaque cache identity.
 * Authentication, authority, and HTTP framing must continue to distinguish
 * requests even when callers configure other volatile application headers.
 */
export function normalizeIgnoredHttpHeaders(headers = []) {
  if (!Array.isArray(headers)) throw new Error("ignored HTTP headers must be an array");
  const result = new Set();
  for (const header of headers) {
    if (typeof header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(header)) {
      throw new Error("ignored HTTP header names must be valid header names");
    }
    const normalized = header.toLowerCase();
    if (PROTECTED_IDENTITY_HEADERS.has(normalized) || SENSITIVE_HEADER.test(normalized) || SENSITIVE_NAME.test(normalized)) {
      throw new Error(`ignored HTTP header is protected: ${normalized}`);
    }
    result.add(normalized);
  }
  return result;
}

function normalizeVolatileHeaderValue(name, value) {
  if (REQUEST_ID_HEADERS.has(name) && UUID_OR_HEX_REQUEST_ID.test(value)) return "[VOLATILE_REQUEST_ID]";
  if (name === "traceparent" && TRACEPARENT.test(value)) return "[VOLATILE_TRACE]";
  if (name === "b3" && B3_SINGLE.test(value)) return "[VOLATILE_TRACE]";
  if (name === "x-b3-traceid" && B3_TRACE_ID.test(value)) return "[VOLATILE_TRACE]";
  if ((name === "x-b3-spanid" || name === "x-b3-parentspanid") && B3_SPAN_ID.test(value)) return "[VOLATILE_TRACE]";
  if ((name === "x-b3-sampled" || name === "x-b3-flags") && /^(?:0|1)$/.test(value)) return "[VOLATILE_TRACE]";
  return value;
}

export function requestDestinationKey(request) {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  return port ? `${host}:${port}` : `${host}:*`;
}

export function callbackDestinationKey(host, port) {
  const normalized = String(host).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return `${normalized}:${port ?? "*"}`;
}

async function inspectBody(stream, maxBytes, timeoutMs) {
  const reader = stream.getReader();
  const chunks = [];
  let observed = 0;
  let complete = false;
  let timedOut = false;
  let timeoutHandle;
  const deadline = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    timeoutHandle.unref?.();
  });
  try {
    while (observed <= maxBytes) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result?.timeout) {
        timedOut = true;
        break;
      }
      if (result.done) {
        complete = true;
        break;
      }
      const chunk = Buffer.from(result.value);
      const remaining = Math.max(0, maxBytes + 1 - observed);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      observed += chunk.byteLength;
      if (observed > maxBytes) break;
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const inspected = Buffer.concat(chunks);
  const flags = bodyRiskFlags(inspected, { complete, timedOut, exceeded: observed > maxBytes });
  return {
    bodyObservedBytes: Math.min(observed, maxBytes + 1),
    bodyComplete: complete,
    ...(complete ? { bodySha256: createHash("sha256").update(inspected).digest("hex") } : {}),
    ...(flags.length > 0 ? { bodyRiskFlags: flags } : {}),
  };
}

function bodyRiskFlags(bytes, state) {
  const flags = [];
  if (state.timedOut) flags.push("inspection-timeout");
  if (state.exceeded) flags.push("body-over-limit");
  const text = bytes.toString("utf8");
  if (/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(text)) flags.push("private-key-shape");
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)) flags.push("jwt-shape");
  if (/(?:password|passwd|secret|api[-_]?key|access[-_]?token)\s*["'=:\s]+[^\s"']{4,}/i.test(text)) flags.push("secret-field-shape");
  return sortedUnique(flags);
}

function sanitizePath(pathname) {
  let redactNext = false;
  const result = pathname.split("/").map((segment) => {
    if (!segment) return segment;
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    if (redactNext || looksSensitiveSegment(decoded) || SENSITIVE_NAME.test(decoded)) {
      redactNext = SENSITIVE_NAME.test(decoded);
      return "[REDACTED]";
    }
    redactNext = false;
    const lower = decoded.toLowerCase();
    if (SAFE_ROUTE_SEGMENTS.has(lower) || /^v\d{1,2}$/.test(lower)) return lower;
    if (/^\d+$/.test(decoded)) return ":number";
    const extension = /\.([a-z0-9]{1,8})$/i.exec(decoded)?.[1]?.toLowerCase();
    return extension ? `:segment.${extension}` : ":segment";
  }).join("/");
  return result.slice(0, 1_024) || "/";
}

function sanitizeNames(names, allowlist, sensitivePattern = SENSITIVE_NAME) {
  let custom = 0;
  let sensitive = 0;
  return names.map((name) => {
    if (sensitivePattern.test(name) || SENSITIVE_NAME.test(name)) return `[SENSITIVE_${++sensitive}]`;
    if (allowlist.has(name.toLowerCase())) return name.toLowerCase();
    return `[CUSTOM_${++custom}]`;
  });
}

function placeholders(values, label) {
  return values.map((_value, index) => `[${label}_${index + 1}]`);
}

function looksSensitiveSegment(value) {
  if (value.length > 64) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(value)) return true;
  if (value.length >= 24 && /^[A-Za-z0-9_=-]+$/.test(value)) {
    return new Set(value).size >= Math.min(12, Math.floor(value.length / 2));
  }
  return false;
}

function parseContentLength(value) {
  if (value === null || !/^\d+$/.test(value)) return;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return;
  return parsed;
}

function safeContentType(value) {
  if (!value) return;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType.slice(0, 128)
    : undefined;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
