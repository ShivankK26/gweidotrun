"use client";

import { createAppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { mainnet } from "@reown/appkit/networks";

const projectId =
  process.env.NEXT_PUBLIC_PROJECT_ID || "95f08db78c4d3c32fd283c319fcbe301";

const origin =
  typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

createAppKit({
  adapters: [new EthersAdapter()],
  projectId,
  networks: [mainnet],
  defaultNetwork: mainnet,
  metadata: {
    name: "gwei.run",
    description: "gas horse mempool race",
    url: origin,
    icons: ["https://gwei.run/icon.png"],
  },
  features: {
    analytics: false,
  },
});

