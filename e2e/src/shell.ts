import { spawnSync } from "node:child_process";

export type CommandResult = {
  command: string;
  status: number;
  stdout: string;
  stderr: string;
};

export function run(
  command: string,
  args: string[],
  cwd = process.cwd(),
  env?: NodeJS.ProcessEnv
): CommandResult {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  return {
    command: formatCommand(command, args),
    status: result.error && "code" in result.error && result.error.code === "ETIMEDOUT"
      ? 124
      : result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function commandInvocation(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (command !== "cast") return { command, args };
  return {
    command: "docker",
    args: [
      "exec",
      "porep-market-curio-devnet-curio-1",
      "cast",
      ...args.map((arg) =>
        arg === "http://127.0.0.1:2234/rpc/v1"
          ? "http://lotus:1234/rpc/v1"
          : arg
      ),
    ],
  };
}

export function runRequired(
  command: string,
  args: string[],
  cwd = process.cwd(),
  env?: NodeJS.ProcessEnv
): string {
  const result = run(command, args, cwd, env);
  if (result.status !== 0) {
    throw new Error(`${result.command} failed with ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function formatCommand(command: string, args: string[]): string {
  const redacted = args.map((arg, index) => {
    if (args[index - 1] === "--private-key") return "REDACTED";
    if (/^0x[0-9a-fA-F]{64}$/.test(arg) && args[index - 1]?.includes("KEY")) return "REDACTED";
    return arg;
  });
  return [command, ...redacted].join(" ");
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
