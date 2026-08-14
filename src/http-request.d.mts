export interface HttpRequestSummary {
  method: string;
  origin: string;
  path: string;
  queryParameterNames: string[];
  sensitiveQueryParameterNames: string[];
  headerNames: string[];
  sensitiveHeaderNames: string[];
  contentType?: string;
  declaredContentLength?: number;
  bodyPresent: boolean;
  bodyObservedBytes?: number;
  bodyComplete?: boolean;
  bodySha256?: string;
  bodyRiskFlags?: string[];
}

export function summarizeHttpRequest(
  request: Request,
  options?: { maxBodyBytes?: number; bodyReadTimeoutMs?: number },
): Promise<Readonly<HttpRequestSummary>>;
export function isUninspectableHttpRequest(summary: HttpRequestSummary): boolean;
export function httpRequestScopeFingerprint(
  request: Request,
  summary: HttpRequestSummary,
  secret: Uint8Array | string,
): string;
export function requestDestinationKey(request: Request): string;
export function callbackDestinationKey(host: string, port?: number): string;
