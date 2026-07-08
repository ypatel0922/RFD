"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "./ui/button";

export function PublicHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-200/80 bg-zinc-50/95 backdrop-blur">
      <div className="mx-auto w-full min-w-0 max-w-7xl px-4 py-3 md:px-5 md:py-4 lg:px-10">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-slate-700/90 bg-gradient-to-r from-[#172033] via-[#1e293b] to-[#172033] px-4 py-3 shadow-lg shadow-slate-900/20 md:px-6 md:py-4">
          <Link
            href="/"
            className="flex min-w-0 shrink-0 items-center gap-2 text-lg font-semibold tracking-tight text-white"
          >
            <span className="rounded-md bg-slate-700/90 px-2 py-1 text-xs font-bold text-white">RFD</span>
            Firebook
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="border-slate-500 bg-slate-800/60 text-white hover:bg-slate-700/80"
            >
              <Link href="/login">Sign In</Link>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-zinc-200 bg-white py-8">
      <div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-4 px-4 text-sm text-zinc-600 md:flex-row md:items-center md:justify-between md:px-6 lg:px-10">
        <p>© {new Date().getFullYear()} Firebook for Fire Departments</p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/privacy" className="font-semibold text-zinc-600 hover:text-zinc-900">
            Privacy Policy
          </Link>
          <Link href="/terms" className="font-semibold text-zinc-600 hover:text-zinc-900">
            Terms of Service
          </Link>
          <Link href="/sms-policy" className="font-semibold text-zinc-600 hover:text-zinc-900">
            SMS Policy
          </Link>
          <Link href="/login" className="font-semibold text-zinc-600 hover:text-zinc-900">
            Sign In
          </Link>
          <Link href="/#demo" className="font-semibold text-zinc-600 hover:text-zinc-900">
            Request Demo
          </Link>
        </div>
      </div>
    </footer>
  );
}

export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="border-l-4 border-[#8B0E16] pl-3 text-lg font-semibold text-zinc-900">{title}</h2>
      <div className="space-y-3 text-[0.95rem] leading-relaxed text-zinc-700">{children}</div>
    </section>
  );
}

export function LegalPageLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen w-full max-w-[100vw] overflow-x-hidden bg-zinc-50 text-zinc-900">
      <PublicHeader />
      <div className="mx-auto w-full min-w-0 max-w-3xl px-4 py-10 md:px-6 lg:py-14">
        <article className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm md:p-10">
          <div className="space-y-6">
            <header className="space-y-2 border-b border-zinc-100 pb-6">
              <h1 className="text-3xl font-bold tracking-tight text-zinc-900 md:text-4xl">{title}</h1>
              <p className="text-sm text-zinc-500">Last updated: July 8, 2026</p>
            </header>
            <div className="space-y-8">{children}</div>
          </div>
        </article>
      </div>
      <PublicFooter />
    </main>
  );
}
