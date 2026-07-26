#!/usr/bin/env node
import { spawn } from "node:child_process";

const OUTPUT_TAIL_BYTES = 8 * 1024;

function parseArguments(args) {
  let timeoutMs;
  let graceMs = 5_000;
  let commandIndex = -1;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") {
      commandIndex = index + 1;
      break;
    }
    if (value === "--timeout-ms" || value === "--grace-ms") {
      const parsed = Number(args[index + 1]);
      if (!Number.isInteger(parsed) || parsed <= 0) usage();
      if (value === "--timeout-ms") timeoutMs = parsed;
      else graceMs = parsed;
      index += 1;
      continue;
    }
    usage();
  }

  if (timeoutMs === undefined || commandIndex === -1 || commandIndex >= args.length) usage();
  return { command: args.slice(commandIndex), graceMs, timeoutMs };
}

function usage() {
  console.error("usage: run-with-timeout.mjs --timeout-ms <positive integer> [--grace-ms <positive integer>] -- <command> [args...]");
  process.exit(2);
}

function appendTail(current, chunk) {
  const combined = Buffer.concat([current, chunk]);
  return combined.length > OUTPUT_TAIL_BYTES ? combined.subarray(combined.length - OUTPUT_TAIL_BYTES) : combined;
}

function describe(command) {
  return `${command[0]} (argument count ${command.length - 1})`;
}

async function main() {
  const { command, graceMs, timeoutMs } = parseArguments(process.argv.slice(2));
  const label = describe(command);
  const child = spawn(command[0], command.slice(1), {
    detached: process.platform !== "win32",
    env: process.env,
    shell: false,
    stdio: ["inherit", "pipe", "pipe"],
  });
  let stderrTail = Buffer.alloc(0);
  let timedOut = false;
  let terminated = false;
  let shutdownRequested = false;
  let escalation;
  let settlement;
  let timeout;
  let forcedExitCode;

  const forward = (source, destination, onChunk, onShutdownChunk) => {
    let drain;
    let shutdownChunk;
    const onData = (chunk) => {
      onChunk?.(chunk);
      if (!destination.write(chunk)) {
        source.pause();
        drain = () => {
          drain = undefined;
          source.resume();
        };
        destination.once("drain", drain);
      }
    };
    source.on("data", onData);
    return {
      cleanup() {
        source.off("data", onData);
        if (shutdownChunk) source.off("data", shutdownChunk);
        if (drain) destination.off("drain", drain);
      },
      drainAndDiscard() {
        source.off("data", onData);
        if (drain) destination.off("drain", drain);
        if (onShutdownChunk) {
          shutdownChunk = onShutdownChunk;
          source.on("data", shutdownChunk);
        }
        source.resume();
      },
    };
  };

  const stdout = forward(child.stdout, process.stdout);
  const stderr = forward(
    child.stderr,
    process.stderr,
    (chunk) => { stderrTail = appendTail(stderrTail, chunk); },
    (chunk) => { stderrTail = appendTail(stderrTail, chunk); },
  );

  const signal = (name) => {
    if (child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`could not send ${name} to command ${label}: ${detail}\n`);
    }
  };

  const shutdown = (name, reason, exitCode) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    forcedExitCode = exitCode;
    clearTimeout(timeout);
    stdout.drainAndDiscard();
    stderr.drainAndDiscard();
    process.stderr.write(reason);
    signal(name);
    escalation = setTimeout(() => {
      if (!terminated) {
        process.stderr.write(`command ${label} did not exit within ${graceMs}ms; sending SIGKILL\n`);
        signal("SIGKILL");
      }
    }, graceMs);
    settlement = setTimeout(() => {
      if (!terminated) process.stderr.write(`command ${label} did not settle after SIGKILL; exiting\n`);
      cleanup();
      process.exit(forcedExitCode ?? 1);
    }, graceMs * 2);
    settlement.unref();
  };

  const onSignal = (name) => {
    if (timedOut) return;
    shutdown(name, `received ${name}; forwarding to command ${label}\n`, name === "SIGINT" ? 130 : 143);
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  timeout = setTimeout(() => {
    timedOut = true;
    shutdown("SIGTERM", `command ${label} timed out after ${timeoutMs}ms; sending SIGTERM\n`, 124);
  }, timeoutMs);

  const cleanup = (preserveSettlement = false) => {
    clearTimeout(timeout);
    if (escalation) clearTimeout(escalation);
    if (settlement && !preserveSettlement) clearTimeout(settlement);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    stdout.cleanup();
    stderr.cleanup();
  };

  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  }).catch((error) => {
    cleanup();
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`could not start command ${label}: ${detail}\n`);
    process.exitCode = 127;
    return undefined;
  });

  if (outcome === undefined) return;
  terminated = true;
  cleanup(true);
  const lastState = stderrTail.toString("utf8");
  if (forcedExitCode === 124) {
    if (lastState !== "") process.stderr.write(`last stderr from ${label}: ${lastState}\n`);
    process.exitCode = 124;
    return;
  }
  if (forcedExitCode !== undefined) {
    process.exitCode = forcedExitCode;
    return;
  }
  if (outcome.exitCode !== 0) {
    const reason = outcome.exitCode === null ? `signal ${outcome.exitSignal}` : `exit code ${outcome.exitCode}`;
    process.stderr.write(`command failed with ${reason}: ${label}\n`);
    if (lastState !== "") process.stderr.write(`last stderr from ${label}: ${lastState}\n`);
    process.exitCode = outcome.exitCode ?? 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
