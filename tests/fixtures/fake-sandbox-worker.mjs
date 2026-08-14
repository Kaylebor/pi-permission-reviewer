let responses = 0;
let expectedResponses = 2;
let invocationNonce;
let invocationToolCallId;

function send(message) {
  process.send({ ...message, invocationNonce });
}

process.on("message", (message) => {
  if (message.type === "start") {
    invocationNonce = message.invocationNonce;
    invocationToolCallId = message.toolCallId;
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
    if (message.requestId === "http-destination" && message.allow === true) {
      expectedResponses = 2;
      responses = 0;
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
      const scopeFingerprint = "a".repeat(64);
      send({ type: "http-request", toolCallId: invocationToolCallId, requestId: "http-1", summary, scopeFingerprint });
      send({ type: "http-request", toolCallId: invocationToolCallId, requestId: "http-2", summary, scopeFingerprint });
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
