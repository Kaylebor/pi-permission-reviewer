import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import test from "node:test";
import { runReactiveSandbox } from "../../src/reactive-sandbox.ts";

const INTEGRATION_ENABLED = process.env.PI_PERMISSION_REVIEWER_SRT_INTEGRATION === "1";
const it = INTEGRATION_ENABLED ? test : test.skip;

function parseResult(output) {
  const lines = output.split(/\n/);
  const resultIndex = lines.findIndex((line) => line.startsWith("RESULT "));
  const resultLine = lines[resultIndex];
  if (!resultLine) {
    throw new Error(`expected RESULT line from client: ${output}`);
  }
  const status = Number(resultLine.slice("RESULT ".length));
  if (!Number.isInteger(status)) throw new Error(`invalid RESULT status: ${resultLine}`);
  return { body: lines.slice(0, resultIndex).join("\n"), status };
}

function quoteArg(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function commandForRequest({ url, method, body, insecure }) {
  const args = [
    "curl",
    "--silent",
    "--show-error",
    "--noproxy",
    "",
    "--request",
    method,
  ];
  if (insecure) args.push("--insecure");
  if (body !== undefined) {
    args.push("--data-binary", body);
  }
  args.push("--write-out", "\nRESULT %{http_code}\n", url);
  return args.map(quoteArg).join(" ");
}

function networkDecisionFor(caseId, decision) {
  return {
    decision,
    source: "reviewer",
    caseId,
    reason: `integration ${decision}`,
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

async function startHttpCaptureServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method ?? "GET",
      path: request.url ?? "",
      body,
      headers: { ...request.headers },
    });

    if (request.url === "/echo" || request.url === "/https") {
      response.statusCode = 200;
      response.end(body);
      return;
    }

    response.statusCode = 204;
    response.end("ok");
  });

  const url = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error(`unexpected server address ${String(address)}`));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    url,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startHttpsCaptureServer() {
  const certDir = mkdtempSync(join(tmpdir(), "pi-perm-srt-"));
  const certPath = join(certDir, "server.crt");
  const keyPath = join(certDir, "server.key");
  const commonName = "127.0.0.1";
  const openssl = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${commonName}`,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { encoding: "utf8" },
  );
  if (openssl.status !== 0) {
    throw new Error(`openssl self-signed cert generation failed: ${openssl.stderr || openssl.stdout}`);
  }

  const certificate = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const requests = [];
  const server = createHttpsServer(
    { cert: certificate, key },
    async (request, response) => {
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "GET",
        path: request.url ?? "",
        body,
        headers: { ...request.headers },
      });
      response.statusCode = 200;
      response.end(body);
    },
  );

  const url = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error(`unexpected server address ${String(address)}`));
        return;
      }
      resolve(`https://127.0.0.1:${address.port}`);
    });
  });

  return {
    certDir,
    certPath,
    url,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
    cleanup: () => rmSync(certDir, { recursive: true, force: true }),
  };
}

async function runIntegrationRequest({
  url,
  method,
  body,
  settings,
  onNetworkRequest,
  onHttpRequest,
  caseId,
  insecure = false,
}) {
  const output = [];
  const networkDecisions = [];
  const httpDecisions = [];
  const result = await runReactiveSandbox({
    toolCallId: caseId,
    command: commandForRequest({ url, method, body, insecure }),
    cwd: process.cwd(),
    settings: {
      ...settings,
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    },
    httpInspection: true,
    onData: (chunk) => output.push(chunk),
    onNetworkRequest: async (request) => {
      networkDecisions.push(request);
      return onNetworkRequest(request);
    },
    onHttpRequest: async (summary) => {
      httpDecisions.push(summary);
      return onHttpRequest(summary);
    },
    onNetworkDecision: () => {},
    onHttpDecision: () => {},
  });

  return {
    result,
    parsed: parseResult(Buffer.concat(output).toString("utf8")),
    networkDecisions,
    httpDecisions,
  };
}

it("enforces destination allow/deny and forwards reviewed POST bodies", async () => {
  const hostServer = await startHttpCaptureServer();
  const localOrigin = `${hostServer.url}`;
  try {
    const payload = JSON.stringify({ action: "srt-harness", accepted: true });
    const expectedSha = createHash("sha256").update(payload).digest("hex");
    const allowed = await runIntegrationRequest({
      caseId: "srt-allow",
      url: `${localOrigin}/echo`,
      method: "POST",
      body: payload,
      settings: { network: { allowedDomains: [], deniedDomains: [] } },
      onNetworkRequest: () => networkDecisionFor("srt-allow", "allow"),
      onHttpRequest: (summary) => {
        assert.equal(summary.method, "POST");
        assert.equal(summary.path, "/:segment");
        assert.equal(summary.bodyPresent, true);
        assert.equal(summary.bodyComplete, true);
        assert.equal(summary.bodySha256, expectedSha);
        return networkDecisionFor("srt-allow", "allow");
      },
    });

    assert.equal(allowed.result.exitCode, 0);
    assert.equal(allowed.parsed.status, 200);
    assert.equal(hostServer.requests.length, 1);
    assert.equal(hostServer.requests[0].method, "POST");
    assert.equal(hostServer.requests[0].body, payload);
    assert.equal(allowed.networkDecisions.length, 1);
    assert.equal(allowed.httpDecisions.length, 1);

    const denied = await runIntegrationRequest({
      caseId: "srt-deny",
      url: `${localOrigin}/echo`,
      method: "POST",
      body: payload,
      settings: { network: { allowedDomains: [], deniedDomains: [] } },
      onNetworkRequest: () => networkDecisionFor("srt-deny", "deny"),
      onHttpRequest: () => networkDecisionFor("srt-deny", "allow"),
    });

    assert.equal(denied.result.exitCode, 0);
    assert.equal(denied.parsed.status, 403);
    assert.equal(denied.networkDecisions.length, 1);
    assert.equal(denied.httpDecisions.length, 0);
    assert.equal(hostServer.requests.length, 1);
  } finally {
    await hostServer.close();
  }
});

for (const method of ["GET", "HEAD", "OPTIONS"]) {
  it(`surfaces ${method} declared bodies as incomplete evidence and enforces denial`, async () => {
    const hostServer = await startHttpCaptureServer();
    try {
      const localOrigin = `${hostServer.url}`;
      const denied = await runIntegrationRequest({
        caseId: `srt-${method.toLowerCase()}`,
        url: `${localOrigin}/echo`,
        method,
        body: "declared-body",
        settings: { network: { allowedDomains: [], deniedDomains: [] } },
        onNetworkRequest: () => networkDecisionFor(`srt-${method.toLowerCase()}`, "allow"),
        onHttpRequest: (summary) => {
          assert.equal(summary.bodyPresent, true);
          assert.equal(summary.bodyComplete, false);
          assert.ok(summary.bodyRiskFlags.includes("uninspectable-bodyless-method"));
          return networkDecisionFor(`srt-${method.toLowerCase()}`, "deny");
        },
      });

      assert.equal(denied.result.exitCode, 0);
      assert.equal(denied.parsed.status, 403);
      if (method !== "HEAD") {
        assert.ok(
          /HTTP request denied by permission review/.test(denied.parsed.body),
          denied.parsed.body,
        );
      }
      assert.equal(denied.networkDecisions.length, 1);
      assert.equal(denied.httpDecisions.length, 1);
      assert.equal(hostServer.requests.length, 0);
    } finally {
      await hostServer.close();
    }
  });
}

it("enforces TLS-terminated HTTPS inspection before contacting the local origin", async () => {
  const hostServer = await startHttpsCaptureServer();
  const localOrigin = `${hostServer.url}`;
  try {
    const payload = "https-body";
    const request = await runIntegrationRequest({
      caseId: "srt-https",
      url: `${localOrigin}/https`,
      method: "POST",
      body: payload,
      settings: {
        network: {
          allowedDomains: [],
          deniedDomains: [],
          tlsTerminate: { extraCaCertPaths: [hostServer.certPath] },
        },
      },
      onNetworkRequest: () => networkDecisionFor("srt-https", "allow"),
      onHttpRequest: (summary) => {
        assert.equal(summary.method, "POST");
        assert.equal(summary.path, "/:segment");
        assert.equal(summary.bodyPresent, true);
        assert.equal(summary.bodyComplete, true);
        return networkDecisionFor("srt-https", "deny");
      },
      insecure: true,
    });

    assert.equal(request.result.exitCode, 0);
    assert.equal(request.parsed.status, 403);
    assert.match(request.parsed.body, /HTTP request denied by permission review/);
    assert.equal(request.httpDecisions.length, 1);
    assert.equal(hostServer.requests.length, 0);
  } finally {
    await hostServer.close();
    hostServer.cleanup();
  }
});
