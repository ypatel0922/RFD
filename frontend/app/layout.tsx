import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hallix",
  description: "AI bookkeeping for fire departments",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
  openGraph: {
    title: "Hallix",
    description: "AI bookkeeping for fire departments",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Hallix",
    description: "AI bookkeeping for fire departments",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
