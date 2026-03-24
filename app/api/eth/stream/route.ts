import type { NextRequest } from "next/server";

export const runtime = "nodejs";

type PendingTxPayload = {
  hash: string;
  from: string;
  nonce: number;
  effectiveGasGwei: number;
};

type BlockPayload = {
  blockNumber: number;
  timestamp: number;
};

type StatsPayload = {
  baseFeeGwei: number | null;
  utilizationPct: number | null;
  pendingCount: number;
};

function toNumber(hex: string | undefined): number | null {
  if (!hex) return null;
  try {
    return Number(BigInt(hex));
  } catch {
    return null;
  }
}

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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RPC HTTP error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { result?: T; error?: unknown };
  if ("error" in json && json.error) {
    throw new Error(`RPC returned error: ${JSON.stringify(json.error)}`);
  }
  if (!("result" in json)) {
    throw new Error("RPC response missing result");
  }
  return json.result as T;
}

export async function GET(req: NextRequest) {
  const key = process.env.ALCHEMY_KEY;
  const WSS_URL =
    process.env.ETH_RPC_WSS_URL ??
    (key ? `wss://eth-mainnet.g.alchemy.com/v2/${key}` : undefined);
  const HTTP_URL =
    process.env.ETH_RPC_HTTP_URL ??
    (key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : undefined);

  if (!WSS_URL || !HTTP_URL) {
    return new Response(
      "Missing env vars: set ALCHEMY_KEY or ETH_RPC_HTTP_URL/ETH_RPC_WSS_URL",
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const push = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          )
        );
      };

      // Attempt to keep a steady stream even under low traffic.
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`event: ping\ndata: {}\n\n`));
      }, 15000);

      const pendingSeen = new Map<string, number>();
      let lastSecond = Math.floor(Date.now() / 1000);
      let pendingThisSecond = 0;
      const PENDING_PER_SECOND_CAP = 15;

      let pendingSubId: string | null = null;
      let newHeadsSubId: string | null = null;

      const ws = new WebSocket(WSS_URL);

      const cleanup = () => {
        clearInterval(heartbeat);
        try {
          ws.close();
        } catch {
          // ignore
        }
        controller.close();
      };

      req.signal.addEventListener("abort", cleanup);

      const safeParseJson = (text: string): unknown => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      };

      const processPendingHash = async (hash: string) => {
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec !== lastSecond) {
          lastSecond = nowSec;
          pendingThisSecond = 0;
        }
        if (pendingThisSecond >= PENDING_PER_SECOND_CAP) return;
        pendingThisSecond++;

        // Expire older seen txs to keep counts reasonable.
        const EXPIRY_MS = 60_000;
        for (const [k, t] of pendingSeen.entries()) {
          if (Date.now() - t > EXPIRY_MS) pendingSeen.delete(k);
        }

        // Only fetch if we haven't seen it recently (saves RPC calls).
        if (pendingSeen.has(hash)) return;
        pendingSeen.set(hash, Date.now());

        type RpcTx = {
          hash: string;
          from: string;
          nonce: string;
          gasPrice?: string | null;
          maxFeePerGas?: string | null;
          maxPriorityFeePerGas?: string | null;
        };

        const tx = await jsonRpcHttp<RpcTx | null>(HTTP_URL, "eth_getTransactionByHash", [
          hash,
        ]).catch(() => null);
        if (!tx) return;

        const gasWeiHex = tx.gasPrice ?? tx.maxFeePerGas ?? tx.maxPriorityFeePerGas;
        const effectiveGasGwei = toGwei(gasWeiHex ?? undefined);
        if (effectiveGasGwei == null) return;

        const payload: PendingTxPayload = {
          hash: tx.hash ?? hash,
          from: tx.from,
          nonce: Number(BigInt(tx.nonce)),
          effectiveGasGwei: effectiveGasGwei,
        };

        push("pending", payload);
      };

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: ["pendingTransactions"],
          })
        );

        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "eth_subscribe",
            params: ["newHeads"],
          })
        );
      });

      ws.addEventListener("message", async (ev) => {
        const parsed = safeParseJson(String(ev.data));
        if (!parsed || typeof parsed !== "object") return;
        const msg = parsed as Record<string, unknown>;

        // Subscription response.
        const id = typeof msg.id === "number" ? msg.id : undefined;
        const result = typeof msg.result === "string" ? msg.result : undefined;
        if (result && id != null) {
          if (id === 1) pendingSubId = result;
          if (id === 2) newHeadsSubId = result;
          return;
        }

        // Notification.
        if (msg.method === "eth_subscription" && msg.params) {
          const params = msg.params as Record<string, unknown>;
          const subId = typeof params.subscription === "string" ? params.subscription : undefined;
          const notifResult = params.result;

          if (pendingSubId && subId === pendingSubId) {
            if (typeof notifResult === "string") {
              void processPendingHash(notifResult);
            }
            return;
          }

          if (newHeadsSubId && subId === newHeadsSubId) {
            if (notifResult && typeof notifResult === "object") {
              const r = notifResult as Record<string, unknown>;
              const numberHex = typeof r.number === "string" ? r.number : undefined;
              const timestampHex = typeof r.timestamp === "string" ? r.timestamp : undefined;

              const blockNumber = toNumber(numberHex) ?? 0;
              const timestamp =
                toNumber(timestampHex) ?? Math.floor(Date.now() / 1000);

              const blockPayload: BlockPayload = {
                blockNumber,
                timestamp,
              };
              push("block", blockPayload);

              // Fetch header details for base fee + utilization.
              type BlockHeader = {
                baseFeePerGas?: string | null;
                gasUsed?: string | null;
                gasLimit?: string | null;
              };
              const header = await jsonRpcHttp<BlockHeader>(
                HTTP_URL,
                "eth_getBlockByNumber",
                [numberHex, false]
              ).catch(() => null);

              const baseFeeGwei = toGwei(header?.baseFeePerGas ?? undefined);
              const gasUsed = header?.gasUsed ? BigInt(header.gasUsed) : null;
              const gasLimit = header?.gasLimit ? BigInt(header.gasLimit) : null;
              const utilizationPct =
                gasUsed != null && gasLimit != null && gasLimit > BigInt(0)
                  ? Number((gasUsed * BigInt(100)) / gasLimit)
                  : null;

              const stats: StatsPayload = {
                baseFeeGwei: baseFeeGwei == null ? null : baseFeeGwei,
                utilizationPct: utilizationPct == null ? null : utilizationPct,
                pendingCount: pendingSeen.size,
              };
              push("stats", stats);
            }
          }
        }
      });

      ws.addEventListener("close", () => cleanup());
      ws.addEventListener("error", () => cleanup());
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

