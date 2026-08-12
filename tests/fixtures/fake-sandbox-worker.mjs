let responses = 0;
let expectedResponses = 2;
let invocationNonce;

function send(message) {
  process.send({ ...message, invocationNonce });
}

process.on("message", (message) => {
  if (message.type === "start") {
    invocationNonce = message.invocationNonce;
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
    if (message.requestId === "invalid-1") {
      send({ type: "error", error: "invalid request denied" });
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
  if (message.type === "abort") {
    send({ type: "error", error: "aborted" });
    process.disconnect();
  }
});
