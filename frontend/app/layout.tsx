import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hallix — Financial management for fire departments",
  description:
    "Stop chasing fires in your finances. Hallix helps fire departments track expenses, record money in, manage NYS 2% funds, reconcile accounts, and stay audit-ready.",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
  openGraph: {
    title: "Hallix — Financial management for fire departments",
    description:
      "Modern finance management for fire departments. Track expenses, record money in, manage NYS 2% funds, and stay audit-ready — all in one place.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Hallix — Financial management for fire departments",
    description:
      "Modern finance management for fire departments. Track expenses, record money in, manage NYS 2% funds, and stay audit-ready.",
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
