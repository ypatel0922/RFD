"use client";

import { ShieldCheck, ReceiptText, LineChart, Building2, CheckCircle2 } from "lucide-react";
import Link from "next/link";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";

const features = [
  {
    title: "Receipt Capture + OCR",
    description: "Automatically extract vendors, amounts, dates, and memo details from every receipt.",
    icon: ReceiptText,
  },
  {
    title: "Statement Matching",
    description: "Reconcile expenses against bank statements quickly with intelligent matching hints.",
    icon: ShieldCheck,
  },
  {
    title: "Grant-Ready Reporting",
    description: "Generate audit-friendly spend reports by fund, quarter, account, or category.",
    icon: LineChart,
  },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white text-zinc-900">
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <header className="flex items-center justify-between border-b border-zinc-200 py-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-bold text-white">RFD</span>
            Firebook
          </Link>
          <nav className="hidden items-center gap-8 text-sm text-zinc-600 md:flex">
            <a href="#features" className="hover:text-zinc-900">
              Features
            </a>
            <a href="#ocr" className="hover:text-zinc-900">
              OCR
            </a>
            <a href="#reconciliation" className="hover:text-zinc-900">
              Reconciliation
            </a>
            <a href="#reporting" className="hover:text-zinc-900">
              Reporting
            </a>
          </nav>
          <Button asChild className="bg-zinc-900 text-white hover:bg-zinc-800">
            <Link href="/login">Sign In</Link>
          </Button>
        </header>

        <section className="grid gap-12 py-20 lg:grid-cols-2 lg:items-center">
          <div className="space-y-7">
            <p className="inline-flex rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-medium uppercase tracking-wide text-orange-800">
              Built for fire departments
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">
              Bookkeeping that makes every dollar accountable.
            </h1>
            <p className="max-w-xl text-lg leading-relaxed text-zinc-600">
              Firebook centralizes receipts, statements, reconciliations, and reporting in one secure workflow
              so chiefs, treasurers, and auditors can trust the numbers.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="bg-zinc-900 text-white hover:bg-zinc-800">
                <a href="#demo">Request Demo</a>
              </Button>
              <Button asChild variant="outline" className="border-zinc-300 text-zinc-900">
                <Link href="/login">Go to Sign In</Link>
              </Button>
            </div>
          </div>

          <Card className="rounded-2xl border-zinc-200 bg-zinc-50 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Live Dashboard Preview</CardTitle>
              <CardDescription>Department health at a glance</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-white p-4">
                  <p className="text-xs text-zinc-500">This Month</p>
                  <p className="mt-1 text-xl font-semibold">$84,210</p>
                </div>
                <div className="rounded-xl bg-white p-4">
                  <p className="text-xs text-zinc-500">Unmatched</p>
                  <p className="mt-1 text-xl font-semibold text-orange-700">12</p>
                </div>
              </div>
              <div className="rounded-xl bg-white p-4">
                <p className="mb-3 text-xs text-zinc-500">Top categories</p>
                <div className="space-y-2">
                  {[
                    ["Apparatus Maintenance", "39%"],
                    ["PPE + Uniforms", "27%"],
                    ["Training + Travel", "16%"],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between text-sm">
                      <span>{label}</span>
                      <span className="font-medium">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section id="features" className="grid gap-5 py-8 md:grid-cols-3">
          {features.map((feature) => (
            <Card key={feature.title} className="rounded-2xl border-zinc-200 shadow-sm">
              <CardHeader>
                <feature.icon className="mb-3 h-5 w-5 text-orange-700" />
                <CardTitle className="text-xl">{feature.title}</CardTitle>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </section>

        <section id="ocr" className="grid gap-8 py-16 lg:grid-cols-2 lg:items-center">
          <div className="space-y-4">
            <h2 className="text-3xl font-semibold tracking-tight">OCR that actually understands receipts</h2>
            <p className="text-zinc-600">
              Upload or photograph receipts and Firebook extracts line items, taxes, dates, and payment
              references. Team members review exceptions instead of keying in everything manually.
            </p>
            <ul className="space-y-2 text-sm text-zinc-700">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-orange-700" />
                Auto-tagged categories and vendor normalization
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-orange-700" />
                Confidence scores for quick review queues
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-orange-700" />
                Full source image attachment for audit trails
              </li>
            </ul>
          </div>
          <Card className="rounded-2xl border-zinc-200 bg-zinc-50">
            <CardContent className="space-y-3 p-6 text-sm">
              <div className="flex items-center justify-between rounded-lg bg-white p-3">
                <span>Vendor</span>
                <strong>Metro Fire Supply</strong>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white p-3">
                <span>Amount</span>
                <strong>$1,249.33</strong>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white p-3">
                <span>Transaction Date</span>
                <strong>2026-05-02</strong>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white p-3">
                <span>Confidence</span>
                <strong className="text-orange-700">98%</strong>
              </div>
            </CardContent>
          </Card>
        </section>

        <section id="reconciliation" className="grid gap-8 py-16 lg:grid-cols-2 lg:items-center">
          <Card className="order-2 rounded-2xl border-zinc-200 bg-zinc-900 text-zinc-100 lg:order-1">
            <CardContent className="space-y-4 p-6">
              <p className="text-sm text-zinc-300">Bank Reconciliation Workflow</p>
              <div className="space-y-3 text-sm">
                <div className="rounded-lg bg-zinc-800 p-3">1. Import statement from your bank</div>
                <div className="rounded-lg bg-zinc-800 p-3">2. Match statement lines to captured expenses</div>
                <div className="rounded-lg bg-zinc-800 p-3">3. Resolve exceptions with flagged suggestions</div>
                <div className="rounded-lg bg-zinc-800 p-3">4. Lock and export a reconciled period</div>
              </div>
            </CardContent>
          </Card>
          <div className="order-1 space-y-4 lg:order-2">
            <h2 className="text-3xl font-semibold tracking-tight">Reconcile in minutes, not days</h2>
            <p className="text-zinc-600">
              Firebook compares statement lines with OCR expenses and known vendors so mismatches stand out
              immediately. Close your month faster while maintaining transparent controls.
            </p>
          </div>
        </section>

        <section id="reporting" className="grid gap-8 py-16 lg:grid-cols-2 lg:items-center">
          <div className="space-y-4">
            <h2 className="text-3xl font-semibold tracking-tight">Reporting made for boards and auditors</h2>
            <p className="text-zinc-600">
              Build quarterly and annual reports with drill-down detail by account, fund, and category. Every
              number traces back to source documents and approval history.
            </p>
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
              <Building2 className="h-4 w-4 text-orange-700" />
              Trusted workflow for volunteer and municipal departments
            </div>
          </div>
          <Card className="rounded-2xl border-zinc-200">
            <CardContent className="p-6">
              <div className="space-y-3 rounded-xl bg-zinc-50 p-4 text-sm">
                <div className="flex justify-between border-b border-zinc-200 pb-2">
                  <span>Total Expenses (Q2)</span>
                  <strong>$241,992.12</strong>
                </div>
                <div className="flex justify-between border-b border-zinc-200 pb-2">
                  <span>Reconciled Rate</span>
                  <strong>98.7%</strong>
                </div>
                <div className="flex justify-between">
                  <span>Open Exceptions</span>
                  <strong className="text-orange-700">9 items</strong>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section id="demo" className="py-16">
          <Card className="rounded-2xl border-zinc-200 bg-zinc-50">
            <CardHeader>
              <CardTitle className="text-2xl">Request a Demo</CardTitle>
              <CardDescription>See Firebook tailored to your department workflow.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4 md:grid-cols-2">
                <Input placeholder="Full Name" aria-label="Full Name" />
                <Input placeholder="Work Email" type="email" aria-label="Work Email" />
                <Input placeholder="Department Name" aria-label="Department Name" />
                <Input placeholder="Department Size" aria-label="Department Size" />
                <div className="md:col-span-2">
                  <Button className="w-full bg-zinc-900 text-white hover:bg-zinc-800 md:w-auto">
                    Request Demo
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </section>
      </div>

      <footer className="border-t border-zinc-200 py-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 text-sm text-zinc-500 md:flex-row md:items-center md:justify-between lg:px-10">
          <p>© {new Date().getFullYear()} Firebook for Fire Departments</p>
          <div className="flex items-center gap-5">
            <Link href="/login" className="hover:text-zinc-800">
              Sign In
            </Link>
            <a href="#demo" className="hover:text-zinc-800">
              Request Demo
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
