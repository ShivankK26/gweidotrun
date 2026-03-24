"use client";

import "@/context/appkit";
import { useEffect } from "react";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";

type Props = {
  connectedAddress: string | null;
};

function short(addr: string) {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function AppKitWalletPill({ connectedAddress }: Props) {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("appkit-account", {
        detail: {
          isConnected,
          address: isConnected && address ? address : null,
        },
      })
    );
  }, [isConnected, address]);

  return (
    <button className={`pill ${connectedAddress ? "active" : ""}`} onClick={() => open()}>
      {connectedAddress ? short(connectedAddress) : "Connect wallet"}
    </button>
  );
}

