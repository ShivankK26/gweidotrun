"use client";

import { createAppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { mainnet } from "@reown/appkit/networks";

const projectId =
  process.env.NEXT_PUBLIC_PROJECT_ID || "b56e18d47c72ab683b10814fe9495694";

createAppKit({
  adapters: [new EthersAdapter()],
  projectId,
  networks: [mainnet],
  defaultNetwork: mainnet,
  metadata: {
    name: "gwei.run",
    description: "gas horse mempool race",
    url: "https://gwei.run",
    icons: ["https://gwei.run/icon.png"],
  },
  features: {
    analytics: true,
  },
});

