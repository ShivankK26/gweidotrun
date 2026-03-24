import type { NextRequest } from "next/server";

export const runtime = "nodejs";

function toGwei(hex: string | undefined): number | null {
  if (!hex) return null;
  try {
    return Number(BigInt(hex) / BigInt(1_000_000_000));
  } catch {
    return null;
  }
}

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
  const HTTP_URL = process.env.ETH_RPC_HTTP_URL;
  if (!HTTP_URL) return new Response("Missing ETH_RPC_HTTP_URL", { status: 500 });

  const { searchParams } = new URL(req.url);
  const hash = searchParams.get("hash");
  if (!hash) return new Response("Missing ?hash=", { status: 400 });

  type RpcTx = {
    hash: string;
    from: string;
    nonce: string;
    value: string;
    gasPrice?: string | null;
    maxFeePerGas?: string | null;
    maxPriorityFeePerGas?: string | null;
  };

  const tx = await jsonRpcHttp<RpcTx | null>(HTTP_URL, "eth_getTransactionByHash", [
    hash,
  ]).catch(() => null);

  if (!tx) return new Response(JSON.stringify({ tx: null }), { status: 200 });

  const gasWeiHex = tx.gasPrice ?? tx.maxFeePerGas ?? tx.maxPriorityFeePerGas ?? undefined;
  const effectiveGasGwei = toGwei(gasWeiHex);

  return Response.json({
    tx: {
      hash: tx.hash,
      from: tx.from,
      nonce: Number(BigInt(tx.nonce)),
      valueWei: tx.value,
      effectiveGasGwei,
    },
  });
}

