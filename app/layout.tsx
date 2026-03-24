import type { Metadata } from "next";
import "./globals.css";
import AppKitInit from "@/components/AppKitInit";

export const metadata: Metadata = {
  title: "gwei.run",
  description: "gas.horse — live mempool races for your Ethereum transaction",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">
        <AppKitInit />
        {children}
      </body>
    </html>
  );
}
