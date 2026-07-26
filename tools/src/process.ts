import { spawn, type ChildProcess } from "node:child_process";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** Maximum bytes retained per output stream; retain a marked diagnostic tail. */
export const OUTPUT_CAPTURE_LIMIT_BYTES = 64 * 1024;
const TRUNCATION_MARKER_TEXT = "\n[output truncated]\n";
const TRUNCATION_MARKER = Buffer.from(TRUNCATION_MARKER_TEXT);
const STDERR_ERROR_LIMIT = 4_096;
const TERMINATION_GRACE_MS = 1_000;
const KILL_CONFIRMATION_MS = 250;
const KILL_CONFIRMATION_POLL_MS = 10;
const USE_PROCESS_GROUPS = process.platform !== "win32";
const activeProcessGroups = new Set<number>();
let forwardedSignal: NodeJS.Signals | undefined;
let externalKillTimer: NodeJS.Timeout | undefined;
let signalHandlersInstalled = false;

const handleSigint = (): void => {
  forwardExternalSignal("SIGINT");
};

const handleSigterm = (): void => {
  forwardExternalSignal("SIGTERM");
};

export async function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`timeoutMs must be a positive finite number, got ${options.timeoutMs}`);
  }

  const startedAt = performance.now();
  const invocation = [command, ...args].map(quote).join(" ");
  const context = `${invocation} (cwd: ${quote(options.cwd)})`;

  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: USE_PROCESS_GROUPS,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`failed to start ${context}: ${errorMessage(error)}`));
      return;
    }

    const processGroupPid = USE_PROCESS_GROUPS ? child.pid : undefined;
    if (processGroupPid !== undefined) registerProcessGroup(processGroupPid);
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killGrace: NodeJS.Timeout | undefined;
    let killConfirmation: NodeJS.Timeout | undefined;
    let cleanupUnconfirmed: Error | undefined;
    const finish = (outcome: (() => void)): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killGrace !== undefined) clearTimeout(killGrace);
      if (killConfirmation !== undefined) clearTimeout(killConfirmation);
      if (processGroupPid !== undefined) unregisterProcessGroup(processGroupPid);
      outcome();
    };
    timeout = setTimeout(() => {
      timedOut = true;
      cleanupUnconfirmed = signalChild(child, processGroupPid, "SIGTERM");
      killGrace = setTimeout(() => {
        if (settled) return;
        const killError = signalChild(child, processGroupPid, "SIGKILL");
        if (killError !== undefined) {
          cleanupUnconfirmed = killError;
          finish(() => reject(new Error(timeoutError(
            context,
            options.timeoutMs,
            stderr.toString(),
            cleanupUnconfirmed,
          ))));
          return;
        }
        if (processGroupPid === undefined) {
          finish(() => reject(new Error(timeoutError(context, options.timeoutMs, stderr.toString()))));
          return;
        }

        const confirmationDeadline = performance.now() + KILL_CONFIRMATION_MS;
        const confirmProcessGroupTermination = (): void => {
          if (settled) return;
          const state = processGroupState(processGroupPid);
          if (state.status === "gone") {
            finish(() => reject(new Error(timeoutError(context, options.timeoutMs, stderr.toString()))));
            return;
          }
          if (state.status === "unknown") cleanupUnconfirmed = state.error;
          if (performance.now() >= confirmationDeadline) {
            const detail = cleanupUnconfirmed
              ?? new Error(`process group ${processGroupPid} still exists after SIGKILL`);
            finish(() => reject(new Error(timeoutError(context, options.timeoutMs, stderr.toString(), detail))));
            return;
          }
          killConfirmation = setTimeout(confirmProcessGroupTermination, KILL_CONFIRMATION_POLL_MS);
        };
        confirmProcessGroupTermination();
      }, TERMINATION_GRACE_MS);
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCaptured(stderr, chunk);
    });
    child.once("error", (error) => {
      finish(() => reject(new Error(`failed to run ${context}: ${errorMessage(error)}${formatStderr(stderr.toString())}`)));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      const durationMs = Math.round(performance.now() - startedAt);
      if (timedOut) {
        if (processGroupPid === undefined) {
          finish(() => reject(new Error(timeoutError(context, options.timeoutMs, stderr.toString()))));
          return;
        }
        const state = processGroupState(processGroupPid);
        if (state.status === "gone") {
          finish(() => reject(new Error(timeoutError(context, options.timeoutMs, stderr.toString()))));
        } else if (state.status === "unknown") {
          cleanupUnconfirmed = state.error;
        }
        return;
      }
      if (exitCode !== 0) {
        const reason = exitCode === null ? `signal ${signal ?? "unknown"}` : `exit code ${exitCode}`;
        finish(() => reject(new Error(`${context} failed with ${reason}${formatStderr(stderr.toString())}`)));
        return;
      }
      finish(() => resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0, durationMs }));
    });
  });
}

function registerProcessGroup(pid: number): void {
  activeProcessGroups.add(pid);
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
}

function unregisterProcessGroup(pid: number): void {
  activeProcessGroups.delete(pid);
  if (activeProcessGroups.size > 0) return;
  if (forwardedSignal !== undefined) {
    reraiseExternalSignal();
    return;
  }
  removeSignalHandlers();
}

function forwardExternalSignal(signal: NodeJS.Signals): void {
  if (forwardedSignal !== undefined) return;
  forwardedSignal = signal;
  for (const pid of activeProcessGroups) {
    signalProcessGroup(pid, signal);
  }
  externalKillTimer = setTimeout(() => {
    for (const pid of activeProcessGroups) {
      signalProcessGroup(pid, "SIGKILL");
    }
    reraiseExternalSignal();
  }, TERMINATION_GRACE_MS);
}

function reraiseExternalSignal(): void {
  const signal = forwardedSignal;
  if (signal === undefined) return;
  forwardedSignal = undefined;
  if (externalKillTimer !== undefined) {
    clearTimeout(externalKillTimer);
    externalKillTimer = undefined;
  }
  removeSignalHandlers();
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
}

function removeSignalHandlers(): void {
  if (!signalHandlersInstalled) return;
  signalHandlersInstalled = false;
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
}

function signalChild(
  child: ChildProcess,
  processGroupPid: number | undefined,
  signal: NodeJS.Signals,
): Error | undefined {
  if (processGroupPid !== undefined) {
    return signalProcessGroup(processGroupPid, signal);
  }
  try {
    child.kill(signal);
    return undefined;
  } catch (error) {
    return new Error(`could not send ${signal} to child ${child.pid ?? "unknown"}: ${errorDescription(error)}`);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): Error | undefined {
  try {
    process.kill(-pid, signal);
    return undefined;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return undefined;
    return new Error(`could not send ${signal} to process group ${pid}: ${errorDescription(error)}`);
  }
}

type ProcessGroupState =
  | { status: "alive" }
  | { status: "gone" }
  | { status: "unknown"; error: Error };

function processGroupState(pid: number): ProcessGroupState {
  try {
    process.kill(-pid, 0);
    return { status: "alive" };
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return { status: "gone" };
    return {
      status: "unknown",
      error: new Error(`process group ${pid} liveness check failed: ${errorDescription(error)}`),
    };
  }
}

function timeoutError(context: string, timeoutMs: number, stderr: string, cleanupError?: Error): string {
  const cleanupDetail = cleanupError === undefined
    ? ""
    : `; could not confirm process group termination: ${cleanupError.message}`;
  return `${context} timed out after ${timeoutMs}ms${cleanupDetail}${formatStderr(stderr)}`;
}

function appendCaptured(existing: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (existing.length + chunk.length <= OUTPUT_CAPTURE_LIMIT_BYTES) {
    return Buffer.concat([existing, chunk]);
  }

  const tailLength = OUTPUT_CAPTURE_LIMIT_BYTES - TRUNCATION_MARKER.length;
  if (chunk.length >= tailLength) {
    return Buffer.concat([TRUNCATION_MARKER, chunk.subarray(-tailLength)]);
  }
  return Buffer.concat([TRUNCATION_MARKER, existing.subarray(-(tailLength - chunk.length)), chunk]);
}

function formatStderr(stderr: string): string {
  if (stderr.length === 0) return "";
  const tail = stderr.slice(-STDERR_ERROR_LIMIT);
  const bounded = stderr.startsWith(TRUNCATION_MARKER_TEXT)
    ? `${TRUNCATION_MARKER_TEXT}${tail.slice(-(STDERR_ERROR_LIMIT - TRUNCATION_MARKER_TEXT.length))}`
    : tail;
  return `; stderr: ${JSON.stringify(bounded)}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDescription(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
  return code === undefined ? errorMessage(error) : `${code}: ${errorMessage(error)}`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
