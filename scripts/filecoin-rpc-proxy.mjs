#!/usr/bin/env node
import { createServer } from "node:http";

const upstream = process.env.FILECOIN_RPC_UPSTREAM;
const port = Number(process.env.FILECOIN_RPC_PROXY_PORT ?? "1235");
if (!upstream || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("FILECOIN_RPC_UPSTREAM and a valid FILECOIN_RPC_PROXY_PORT are required");
}

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", async () => {
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      const calls = JSON.parse(body);
      const callsById = new Map(
        (Array.isArray(calls) ? calls : [calls]).map((call) => [
          String(call.id),
          call,
        ]),
      );
      const upstreamResponse = await post(body);
      const result = await rewriteNullRounds(
        await upstreamResponse.json(),
        callsById,
      );
      response.writeHead(upstreamResponse.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      }));
    }
  });
});

server.listen(port, "127.0.0.1");

async function post(body) {
  return await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function rewriteNullRounds(value, callsById) {
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((item) => rewriteNullRounds(item, callsById)),
    );
  }
  const call = callsById.get(String(value?.id));
  if (
    value
    && call?.method === "eth_getBlockByNumber"
    && value.error?.code === 12
    && /null round/i.test(value.error?.message ?? "")
  ) {
    return {
      jsonrpc: value.jsonrpc ?? "2.0",
      id: value.id,
      result: await syntheticEmptyBlock(call.params?.[0]),
    };
  }
  return value;
}

async function syntheticEmptyBlock(requestedNumber) {
  const requested = BigInt(requestedNumber);
  for (let height = requested - 1n; height >= 0n; height--) {
    const id = `proxy-${height}`;
    const response = await post(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "eth_getBlockByNumber",
      params: [`0x${height.toString(16)}`, false],
    }));
    const block = await response.json();
    if (block.result) {
      const gap = requested - height;
      return {
        ...block.result,
        number: `0x${requested.toString(16)}`,
        hash: syntheticHash(requested),
        parentHash: syntheticHash(requested - 1n),
        timestamp: `0x${(BigInt(block.result.timestamp) + 30n * gap).toString(16)}`,
        transactions: [],
        gasUsed: "0x0",
        size: "0x0",
      };
    }
  }
  throw new Error(`no preceding tipset for null epoch ${requested}`);
}

function syntheticHash(height) {
  return `0x${height.toString(16).padStart(64, "0")}`;
}
