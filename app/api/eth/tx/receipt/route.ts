import type { NextRequest } from "next/server";

export const runtime = "nodejs";

async function jsonRpcHttp<T>(
  url: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP error ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: unknown };
  if ("error" in json && json.error) {
    throw new Error(`RPC returned error`);
  }
  if (!("result" in json)) throw new Error("RPC response missing result");
  return json.result as T;
}

export async function GET(req: NextRequest) {
  const key = process.env.ALCHEMY_KEY;
  const HTTP_URL =
    process.env.ETH_RPC_HTTP_URL ??
    (key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : undefined);
  if (!HTTP_URL) {
    return new Response("Missing env vars: set ALCHEMY_KEY or ETH_RPC_HTTP_URL", {
      status: 500,
    });
  }

  const { searchParams } = new URL(req.url);
  const hash = searchParams.get("hash");
  if (!hash) return new Response("Missing ?hash=", { status: 400 });

  type RpcReceipt = {
    transactionHash: string;
    blockNumber: string;
    status?: string;
    effectiveGasPrice?: string;
  };

  const receipt = await jsonRpcHttp<RpcReceipt | null>(
    HTTP_URL,
    "eth_getTransactionReceipt",
    [hash]
  ).catch(() => null);

  return Response.json({ receipt });
}

