import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gwei.run",
  description: "gas.horse — live mempool races for your Ethereum transaction",
  icons: {
    icon: "/gwei-run-favicon.svg",
    apple: "/gwei-run-favicon.svg",
    shortcut: "/gwei-run-favicon.svg",
  },
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
        {children}
      </body>
    </html>
  );
}
