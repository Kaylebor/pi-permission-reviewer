import { spawn } from "node:child_process";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { PausableTimeout } from "./pausable-timeout.mjs";

let child;
let lifecycle = "idle";
let requestCounter = 0;
let invocationNonce;
const controller = new AbortController();
const pendingNetwork = new Map();
let configuredTimeoutMs;
const executionTimeout = new PausableTimeout(() =>
  void abort(`timeout:${configuredTimeoutMs / 1000}`),
);

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "start") void start(message);
  if (message.type !== "start" && message.invocationNonce !== invocationNonce) return;
  if (message.type === "network-response") {
    const resolve = pendingNetwork.get(message.requestId);
    if (resolve) {
      pendingNetwork.delete(message.requestId);
      resolve(message.allow === true);
    }
  }
  if (message.type === "abort") void abort("aborted");
});

process.on("disconnect", () => void abort("aborted"));

async function start(message) {
  if (lifecycle !== "idle") return;
  if (typeof message.invocationNonce !== "string" || !message.invocationNonce) return;
  invocationNonce = message.invocationNonce;
  lifecycle = "starting";
  try {
    await SandboxManager.initialize(message.settings, ({ host, port }) => {
      if (!isActive() || !process.connected) return Promise.resolve(false);
      const requestId = `${message.toolCallId}:${++requestCounter}`;
      executionTimeout.pause();
      return new Promise((resolve) => {
        pendingNetwork.set(requestId, (allow) => {
          executionTimeout.resume();
          resolve(allow);
        });
        send({
          type: "network-request",
          toolCallId: message.toolCallId,
          requestId,
          host,
          port,
        });
      });
    });
    ensureActive();
    const descriptor = await SandboxManager.wrapWithSandboxArgv(
      message.command,
      undefined,
      undefined,
      controller.signal,
      message.cwd,
      { commandId: message.toolCallId, commandText: message.command },
    );
    ensureActive();
    if (message.timeoutMs !== undefined) {
      configuredTimeoutMs = message.timeoutMs;
      executionTimeout.start(message.timeoutMs);
    }
    child = spawn(descriptor.argv[0], descriptor.argv.slice(1), {
      cwd: message.cwd,
      detached: process.platform !== "win32",
      env: descriptor.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    lifecycle = "running";
    send({ type: "started", toolCallId: message.toolCallId, childPid: child.pid });
    child.stdout?.on("data", (data) => output(data));
    child.stderr?.on("data", (data) => output(data));
    child.on("error", (error) => void finishError(error.message));
    child.on("exit", (code) => {
      if (lifecycle === "aborting") return;
      void finish({ type: "result", exitCode: code });
    });
  } catch (error) {
    await finishError(error instanceof Error ? error.message : String(error));
  }
}

function output(data) {
  send({ type: "output", data: Buffer.from(data).toString("base64") });
}

async function abort(reason) {
  if (["aborting", "finishing", "finished"].includes(lifecycle)) return;
  lifecycle = "aborting";
  controller.abort();
  for (const resolve of pendingNetwork.values()) resolve(false);
  pendingNetwork.clear();
  if (child?.pid) await terminateProcessGroup(child.pid);
  // If initialization is still pending, start() will observe the aborted state
  // before wrapping or spawning and complete teardown itself.
  if (!child && lifecycle === "aborting") return;
  await finishError(reason);
}

async function finishError(error) {
  await finish({ type: "error", error });
}

async function finish(message) {
  if (["finishing", "finished"].includes(lifecycle)) return;
  lifecycle = "finishing";
  executionTimeout.stop();
  for (const resolve of pendingNetwork.values()) resolve(false);
  pendingNetwork.clear();
  if (child?.pid) await terminateProcessGroup(child.pid);
  try {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
  } catch {}
  lifecycle = "finished";
  send(message);
  process.disconnect?.();
  setTimeout(() => process.exit(message.type === "result" ? 0 : 1), 10).unref();
}

function isActive() {
  return lifecycle === "starting" || lifecycle === "running";
}

function ensureActive() {
  if (!isActive() || controller.signal.aborted) throw new Error("aborted");
}

async function terminateProcessGroup(pid) {
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, 500)) return;
  signalProcessGroup(pid, "SIGKILL");
  await waitForProcessGroupExit(pid, 500);
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {}
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processGroupExists(pid);
}

function processGroupExists(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

function send(message) {
  if (process.connected) process.send?.({ ...message, invocationNonce });
}
