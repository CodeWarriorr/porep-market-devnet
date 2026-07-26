import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Filecoin RPC proxy maps null rounds to synthetic empty Ethereum blocks", async (context) => {
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: number;
      method: string;
    };
    const result = call.method === "eth_getBlockByNumber"
      && (call as { params?: string[] }).params?.[0] === "0x2a"
      ? {
          jsonrpc: "2.0",
          id: call.id,
          error: { code: 12, message: "requested epoch was a null round (42)" },
        }
      : call.method === "eth_getBlockByNumber"
        ? {
            jsonrpc: "2.0",
            id: call.id,
            result: {
              number: "0x29",
              hash: `0x${"a".repeat(64)}`,
              parentHash: `0x${"b".repeat(64)}`,
              timestamp: "0x64",
              transactions: ["0xold"],
              gasUsed: "0x10",
              size: "0x20",
            },
          }
        : { jsonrpc: "2.0", id: call.id, result: "0x1df5e76" };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await listen(upstream);
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const reservation = createServer();
  await listen(reservation);
  const proxyAddress = reservation.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()));

  const child = spawn(process.execPath, [
    resolve(repositoryRoot, "scripts", "filecoin-rpc-proxy.mjs"),
  ], {
    env: {
      ...process.env,
      FILECOIN_RPC_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
      FILECOIN_RPC_PROXY_PORT: String(proxyAddress.port),
    },
    stdio: "ignore",
  });
  context.after(() => child.kill());
  const url = `http://127.0.0.1:${proxyAddress.port}`;
  await waitForProxy(url);

  const synthetic = await rpc(url, "eth_getBlockByNumber", 1, ["0x2a", false]) as {
    result: Record<string, unknown>;
  };
  assert.equal(synthetic.result.number, "0x2a");
  assert.equal(synthetic.result.timestamp, "0x82");
  assert.deepEqual(synthetic.result.transactions, []);
  assert.equal(synthetic.result.gasUsed, "0x0");
  assert.deepEqual(await rpc(url, "eth_chainId", 2), {
    jsonrpc: "2.0",
    id: 2,
    result: "0x1df5e76",
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

async function waitForProxy(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rpc(url, "eth_chainId", 0);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error("RPC proxy did not start");
}

async function rpc(
  url: string,
  method: string,
  id: number,
  params: unknown[] = [],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return await response.json();
}
