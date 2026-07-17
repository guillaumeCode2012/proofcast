import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProofCast — Don't trust. Verify.",
  description:
    "The agentic engine that delivers a video proof of your feature before it deploys. Proof before deployment.",
  metadataBase: new URL("https://proofcast.dev"),
  openGraph: {
    title: "ProofCast — Don't trust. Verify.",
    description:
      "The agentic engine that delivers a video proof of your feature before it deploys.",
    type: "website",
    images: [{ url: "/og.png", width: 1699, height: 963, alt: "ProofCast" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ProofCast — Don't trust. Verify.",
    description:
      "The agentic engine that delivers a video proof of your feature before it deploys.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0F16",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#050505] font-sans antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
