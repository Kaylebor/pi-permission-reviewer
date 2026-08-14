let responses = 0;
let expectedResponses = 2;
let invocationNonce;
let invocationToolCallId;
let invocationCommand;
let lruHosts = [];
let lruIndex = 0;
let httpLruFingerprints = [];
let httpLruIndex = 0;
let transientIndex = 0;

function send(message) {
  process.send({ ...message, invocationNonce });
}

process.on("message", (message) => {
  if (message.type === "start") {
    invocationNonce = message.invocationNonce;
    invocationToolCallId = message.toolCallId;
    invocationCommand = message.command;
    if (message.command === "timeout-probe") {
      send({ type: "output", data: Buffer.from(String(message.timeoutMs)).toString("base64") });
      send({ type: "result", exitCode: 0 });
      process.disconnect();
      return;
    }
    if (message.command === "git-env") {
      send({
        type: "output",
        data: Buffer.from(JSON.stringify({
          count: process.env.GIT_CONFIG_COUNT,
          key: process.env.GIT_CONFIG_KEY_0,
          value: process.env.GIT_CONFIG_VALUE_0,
        })).toString("base64"),
      });
      send({ type: "result", exitCode: 0 });
      process.disconnect();
      return;
    }
    if (message.command === "wait") {
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "wait-1",
        host: "example.com",
        port: 443,
      });
      return;
    }
    if (message.command === "http") {
      expectedResponses = 1;
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "http-destination",
        host: "example.com",
        port: 443,
      });
      return;
    }
    if (message.command === "invalid") {
      send({
        type: "network-request",
        toolCallId: "wrong-call",
        requestId: "invalid-1",
        host: "example.com",
        port: 443,
      });
      return;
    }
    if (message.command === "many") {
      expectedResponses = 3;
      for (const [index, host] of ["one.example", "two.example", "three.example"].entries()) {
        send({
          type: "network-request",
          toolCallId: message.toolCallId,
          requestId: `many-${index}`,
          host,
          port: 443,
        });
      }
      return;
    }
    if (message.command === "lru") {
      lruHosts = ["one.example", "two.example", "three.example", "one.example"];
      lruIndex = 0;
      expectedResponses = lruHosts.length;
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: `lru-${lruIndex}`,
        host: lruHosts[lruIndex],
        port: 443,
      });
      return;
    }
    if (message.command === "transient") {
      transientIndex = 0;
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "transient-0",
        host: "retry.example",
        port: 443,
      });
      return;
    }
    if (["http-incomplete", "http-invalid", "http-lru", "http-policy"].includes(message.command)) {
      expectedResponses = 1;
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "http-destination",
        host: "example.com",
        port: 443,
      });
      return;
    }
    if (message.command === "canonical") {
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "canonical-1",
        host: "127.1",
        port: 443,
      });
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "canonical-2",
        host: "127.0.0.1",
        port: 443,
      });
      return;
    }
    if (message.command === "settle") {
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "settle-1",
        host: "example.com",
        port: 443,
      });
      setTimeout(() => {
        send({ type: "result", exitCode: 0 });
        process.disconnect();
      }, 10);
      return;
    }
    if (message.command === "single") {
      expectedResponses = 1;
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "single-1",
        host: "example.com",
        port: 443,
      });
      return;
    }
    if (message.command === "deny") {
      expectedResponses = 1;
      send({
        type: "network-request",
        toolCallId: message.toolCallId,
        requestId: "deny-1",
        host: "example.com",
        port: 443,
      });
      return;
    }
    send({
      type: "network-request",
      toolCallId: message.toolCallId,
      requestId: "request-1",
      host: "example.com",
      port: 443,
    });
    send({
      type: "network-request",
      toolCallId: message.toolCallId,
      requestId: "request-2",
      host: "example.com",
      port: 443,
    });
  }
  if (message.type === "network-response") {
    if (message.requestId?.startsWith("transient-")) {
      transientIndex += 1;
      if (transientIndex === 1) {
        send({
          type: "network-request",
          toolCallId: invocationToolCallId,
          requestId: "transient-1",
          host: "retry.example",
          port: 443,
        });
      } else {
        send({ type: "result", exitCode: 0 });
        process.disconnect();
      }
      return;
    }
    if (message.requestId?.startsWith("lru-")) {
      lruIndex += 1;
      if (lruIndex < lruHosts.length) {
        send({
          type: "network-request",
          toolCallId: invocationToolCallId,
          requestId: `lru-${lruIndex}`,
          host: lruHosts[lruIndex],
          port: 443,
        });
      } else {
        send({ type: "output", data: Buffer.from("continued").toString("base64") });
        send({ type: "result", exitCode: 0 });
        process.disconnect();
      }
      return;
    }
    if (message.requestId === "http-destination" && message.allow === true) {
      if (invocationCommand === "http-policy") {
        send({
          type: "http-policy-denial",
          toolCallId: invocationToolCallId,
          error: "HTTP request metadata inspection failed",
        });
        send({ type: "result", exitCode: 0 });
        process.disconnect();
        return;
      }
      if (invocationCommand === "http-lru") {
        httpLruFingerprints = ["a", "b", "c", "a"];
        httpLruIndex = 0;
        expectedResponses = httpLruFingerprints.length;
        const summary = {
          method: "GET",
          origin: "https://example.com",
          path: "/resource",
          queryParameterNames: ["page"],
          sensitiveQueryParameterNames: [],
          headerNames: ["accept"],
          sensitiveHeaderNames: [],
          bodyPresent: false,
        };
        send({
          type: "http-request",
          toolCallId: invocationToolCallId,
          requestId: `http-lru-${httpLruIndex}`,
          summary,
          scopeFingerprint: httpLruFingerprints[httpLruIndex].repeat(64),
        });
        return;
      }
      expectedResponses = invocationCommand === "http-invalid" ? 1 : 2;
      responses = 0;
      const summary = invocationCommand === "http-invalid" ? {
        bodyPresent: "invalid",
      } : invocationCommand === "http-incomplete" ? {
        method: "GET",
        origin: "https://example.com",
        path: "/resource",
        queryParameterNames: ["page"],
        sensitiveQueryParameterNames: [],
        headerNames: ["accept"],
        sensitiveHeaderNames: [],
        bodyPresent: true,
        bodyObservedBytes: 0,
        bodyComplete: false,
        bodyRiskFlags: ["uninspectable-bodyless-method"],
      } : {
        method: "GET",
        origin: "https://example.com",
        path: "/resource",
        queryParameterNames: ["page"],
        sensitiveQueryParameterNames: [],
        headerNames: ["accept"],
        sensitiveHeaderNames: [],
        bodyPresent: false,
      };
      const scopeFingerprint = "a".repeat(64);
      send({ type: "http-request", toolCallId: invocationToolCallId, requestId: "http-1", summary, scopeFingerprint });
      if (invocationCommand !== "http-invalid") {
        send({ type: "http-request", toolCallId: invocationToolCallId, requestId: "http-2", summary, scopeFingerprint });
      }
      return;
    }
    if (message.requestId === "invalid-1") {
      send({ type: "error", error: "invalid request denied" });
      process.disconnect();
      return;
    }
    if (message.requestId === "deny-1" && message.allow !== true) {
      send({ type: "error", error: "network request denied" });
      process.disconnect();
      return;
    }
    responses += 1;
    if (responses === expectedResponses) {
      send({ type: "output", data: Buffer.from("continued").toString("base64") });
      send({ type: "result", exitCode: 0 });
      process.disconnect();
    }
  }
  if (message.type === "http-response") {
    if (message.requestId?.startsWith("http-lru-")) {
      httpLruIndex += 1;
      if (httpLruIndex < httpLruFingerprints.length) {
        const summary = {
          method: "GET",
          origin: "https://example.com",
          path: "/resource",
          queryParameterNames: ["page"],
          sensitiveQueryParameterNames: [],
          headerNames: ["accept"],
          sensitiveHeaderNames: [],
          bodyPresent: false,
        };
        send({
          type: "http-request",
          toolCallId: invocationToolCallId,
          requestId: `http-lru-${httpLruIndex}`,
          summary,
          scopeFingerprint: httpLruFingerprints[httpLruIndex].repeat(64),
        });
      } else {
        send({ type: "output", data: Buffer.from("http-continued").toString("base64") });
        send({ type: "result", exitCode: 0 });
        process.disconnect();
      }
      return;
    }
    responses += 1;
    if (responses === expectedResponses) {
      send({ type: "output", data: Buffer.from("http-continued").toString("base64") });
      send({ type: "result", exitCode: 0 });
      process.disconnect();
    }
  }
  if (message.type === "abort") {
    send({ type: "error", error: "aborted" });
    process.disconnect();
  }
});
