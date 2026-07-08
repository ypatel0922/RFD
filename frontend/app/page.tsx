"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  Check,
  ClipboardList,
  FolderSearch,
  Link2,
  Search,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";
import Link from "next/link";

import { PublicFooter } from "../components/public-site";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";

const ledgerRows = [
  { name: "NYS 2% Deposit", type: "Income", amount: "+$8,250.00", status: "Cleared" },
  { name: "Member Dues", type: "Income", amount: "+$400.00", status: "Matched" },
  { name: "Uniforms", type: "Expense", amount: "-$620.00", status: "Needs Review" },
  { name: "Monthly Feed", type: "Expense", amount: "-$280.00", status: "Cleared" },
  { name: "FASNY Dues", type: "Expense", amount: "-$30.00", status: "Matched" },
  { name: "Office Supplies", type: "Expense", amount: "-$142.30", status: "Cleared" },
];
const heroLedgerRows = ledgerRows.slice(0, 5);

const featureCards = [
  {
    title: "All Accounts in One Place",
    text: "Bank accounts, credit cards, and funds together on one screen.",
    icon: WalletCards,
  },
  {
    title: "Compliance Made Simple",
    text: "Generate NYS 2% and IRS 990 filings easily.",
    icon: BookOpenCheck,
  },
  {
    title: "Audit Ready",
    text: "Receipts, reports, and records are always easy to find.",
    icon: ShieldCheck,
  },
  {
    title: "Automatic Logs",
    text: "Bank activity and uploaded receipts are saved as you go.",
    icon: ClipboardList,
  },
  {
    title: "Transparency and Analysis",
    text: "See exactly where your money is going.",
    icon: BarChart3,
  },
  {
    title: "Reports in One Click",
    text: "Pull spending, vendor, category, and yearly reports instantly.",
    icon: FolderSearch,
  },
  {
    title: "Automatic Reconciliation",
    text: "Match bank transactions, receipts, and statements in minutes.",
    icon: Link2,
  },
  {
    title: "Search Spending History",
    text: "Find past payments, donations, vendors, and receipts fast.",
    icon: Search,
  },
];

function statusPill(status: string) {
  if (status === "Cleared") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "Matched") return "bg-sky-50 text-sky-700 border-sky-200";
  return "bg-rose-50 text-rose-700 border-rose-200";
}

const heroChecklist = ["Easier", "Cheaper", "Smarter", "Safer"];

const initialDemoForm = {
  fullName: "",
  departmentName: "",
  phoneNumber: "",
  email: "",
  companyWebsite: "",
};

const mobileNavLinks = [
  { href: "#features", label: "Features" },
  { href: "#ocr", label: "OCR" },
  { href: "#reconciliation", label: "Reconciliation" },
  { href: "#reporting", label: "Reporting" },
  { href: "#demo", label: "Request Demo" },
];

export default function HomePage() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [demoForm, setDemoForm] = useState(initialDemoForm);
  const [isSubmittingDemo, setIsSubmittingDemo] = useState(false);
  const [demoSuccessMessage, setDemoSuccessMessage] = useState("");
  const [demoErrorMessage, setDemoErrorMessage] = useState("");

  useEffect(() => {
    function closeOnDesktop() {
      if (window.innerWidth >= 768) setIsMobileMenuOpen(false);
    }
    window.addEventListener("resize", closeOnDesktop);
    closeOnDesktop();
    return () => window.removeEventListener("resize", closeOnDesktop);
  }, []);

  async function handleDemoSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDemoSuccessMessage("");
    setDemoErrorMessage("");
    setIsSubmittingDemo(true);

    try {
      const response = await fetch("/api/request-demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(demoForm),
      });

      if (!response.ok) {
        setDemoErrorMessage("Something went wrong. Please try again.");
        return;
      }

      setDemoForm(initialDemoForm);
      setDemoSuccessMessage("Thanks — we’ll reach out shortly.");
    } catch {
      setDemoErrorMessage("Something went wrong. Please try again.");
    } finally {
      setIsSubmittingDemo(false);
    }
  }

  return (
    <main className="min-h-screen w-full max-w-[100vw] overflow-x-hidden bg-zinc-50 text-zinc-900">
      <header className="sticky top-0 z-20 border-b border-zinc-200/80 bg-zinc-50/95 backdrop-blur">
        <div className="mx-auto w-full min-w-0 max-w-7xl px-4 py-3 md:px-5 md:py-4 lg:px-10">
          <div className="relative">
            <div className="flex min-w-0 items-center justify-between gap-2 rounded-2xl border border-slate-700/90 bg-gradient-to-r from-[#172033] via-[#1e293b] to-[#172033] px-4 py-3 shadow-lg shadow-slate-900/20 md:gap-3 md:px-6 md:py-4">
              <Link href="/" className="shrink-0 flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight text-white">
                <span className="rounded-md bg-slate-700/90 px-2 py-1 text-xs font-bold text-white">RFD</span>
                Firebook
              </Link>
              <nav className="hidden flex-1 items-center justify-center gap-4 text-sm font-semibold md:flex md:gap-5" aria-label="Desktop">
                <a href="#features" className="!text-white hover:!text-white">
                  Features
                </a>
                <a href="#ocr" className="!text-white hover:!text-white">
                  OCR
                </a>
                <a href="#reconciliation" className="!text-white hover:!text-white">
                  Reconciliation
                </a>
                <a href="#reporting" className="!text-white hover:!text-white">
                  Reporting
                </a>
                <a href="#demo" className="!text-white hover:!text-white">
                  Request Demo
                </a>
              </nav>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="border-slate-500 bg-slate-800/60 text-white hover:bg-slate-700/80"
                >
                  <Link href="/login">Sign In</Link>
                </Button>
                <button
                  type="button"
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-2 text-white hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40 active:bg-white/5 md:hidden"
                  aria-expanded={isMobileMenuOpen}
                  aria-controls="mobile-nav-menu"
                  aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
                  onClick={() => setIsMobileMenuOpen((v) => !v)}
                >
                  {isMobileMenuOpen ? (
                    <X className="h-6 w-6 text-zinc-50" strokeWidth={2.5} aria-hidden />
                  ) : (
                    <span className="flex w-8 flex-col gap-[5px]" aria-hidden>
                      <span className="h-[3px] w-full rounded-full bg-white" />
                      <span className="h-[3px] w-full rounded-full bg-white" />
                      <span className="h-[3px] w-full rounded-full bg-white" />
                    </span>
                  )}
                </button>
              </div>
            </div>

            {isMobileMenuOpen ? (
              <nav
                id="mobile-nav-menu"
                aria-label="Mobile"
                className="absolute left-0 right-0 top-full z-40 mt-2 flex flex-col rounded-xl border border-slate-600 bg-gradient-to-b from-[#172033] to-[#1e293b] py-2 shadow-xl shadow-slate-900/35 md:hidden"
              >
                {mobileNavLinks.map(({ href, label }) => (
                  <a
                    key={`${href}-${label}`}
                    href={href}
                    className="block px-4 py-3.5 text-base font-semibold !text-white hover:!text-white hover:bg-slate-800/80 active:bg-slate-800"
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    {label}
                  </a>
                ))}
              </nav>
            ) : null}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full min-w-0 max-w-7xl px-4 md:px-5 lg:px-10">
        <section className="grid min-w-0 grid-cols-1 items-center gap-5 border-b border-zinc-200 py-5 max-md:py-5 lg:grid-cols-[minmax(0,0.47fr)_minmax(0,0.53fr)] lg:gap-8 lg:py-8">
          <div className="order-1 min-w-0 max-w-full space-y-4 lg:min-w-0 lg:pr-2">
            <p className="inline-flex rounded-full border border-[#991B1B]/40 bg-rose-100/90 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[#5c0a0f]">
              Built for fire departments
            </p>
            <h1 className="max-w-full text-4xl font-bold leading-[1.15] tracking-tight text-zinc-900 max-md:break-words max-md:!text-[clamp(1.625rem,5vw+0.25rem,2rem)] max-md:!leading-snug sm:text-5xl lg:text-[2.75rem] xl:text-6xl">
              Stop chasing fires in your finances,{" "}
              <span className="text-[#8B0E16]">let us keep everything contained.</span>
            </h1>
            <p className="max-w-full text-2xl font-semibold leading-snug text-zinc-900 max-md:text-xl max-md:leading-snug sm:text-[1.65rem]">
              Stop spending thousands on accountants.
            </p>
            <ul className="space-y-3 pt-1">
              {heroChecklist.map((item) => (
                <li key={item} className="flex items-center gap-3 text-lg font-medium leading-relaxed text-zinc-800">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-[#991B1B] text-[#8B0E16]"
                    aria-hidden
                  >
                    <Check className="h-4 w-4 stroke-[3]" />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
            <p className="text-base text-zinc-600 max-md:text-lg max-md:leading-relaxed">Built by a firefighter, accountant, and lawyer.</p>
            <div className="flex flex-wrap gap-3 pt-1">
              <Button
                asChild
                size="lg"
                className="max-md:w-full rounded-xl bg-[#8B0E16] px-8 py-6 text-base font-bold text-white shadow-md shadow-slate-900/15 hover:bg-[#991B1B] md:w-auto"
              >
                <a
                  href="#demo"
                  className="inline-flex items-center justify-center !font-bold !text-white hover:!text-white"
                >
                  Request Demo
                  <ArrowRight className="ml-2 h-5 w-5 !text-white" aria-hidden />
                </a>
              </Button>
            </div>
          </div>

          <Card className="order-2 w-full min-w-0 max-w-xl justify-self-stretch rounded-xl border border-zinc-200/90 bg-white shadow-md shadow-zinc-900/8 lg:max-w-none lg:justify-self-end">
            <CardHeader className="space-y-2 border-b border-zinc-200 p-3 pb-2.5 sm:p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base text-zinc-900">Department Ledger</CardTitle>
                  <CardDescription className="text-zinc-600">Live Dashboard Preview</CardDescription>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="rounded-md border border-zinc-300 bg-zinc-900 px-2 py-1 font-medium text-white">
                  All
                </span>
                <span className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 font-medium text-zinc-700">
                  Needs Review
                </span>
                <span className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 font-medium text-zinc-700">
                  Cleared
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-2.5 p-3 sm:p-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Monthly Expenses</p>
                  <p className="text-sm font-semibold text-[#8B0E16]">$2,290</p>
                </div>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Income</p>
                  <p className="text-sm font-semibold text-emerald-700">$9,220</p>
                </div>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Unmatched</p>
                  <p className="text-sm font-semibold text-zinc-900">3</p>
                </div>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Reconciled Rate</p>
                  <p className="text-sm font-semibold text-[#8B0E16]">91%</p>
                </div>
              </div>

              <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">
                Search: Museum donation March 2025
              </div>

              <div className="max-w-full overflow-x-auto rounded-md border border-zinc-200 [-webkit-overflow-scrolling:touch]">
                <table className="min-w-full text-xs sm:text-sm">
                  <thead className="bg-zinc-100 text-left text-zinc-700">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold sm:px-3 sm:py-2">Transaction</th>
                      <th className="px-2 py-1.5 font-semibold sm:px-3 sm:py-2">Type</th>
                      <th className="px-2 py-1.5 font-semibold sm:px-3 sm:py-2">Amount</th>
                      <th className="px-2 py-1.5 font-semibold sm:px-3 sm:py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white text-zinc-800">
                    {heroLedgerRows.map((row) => (
                      <tr key={`${row.name}-${row.amount}`} className="border-t border-zinc-100">
                        <td className="px-2 py-1.5 sm:px-3">{row.name}</td>
                        <td className="px-2 py-1.5 text-zinc-600 sm:px-3">{row.type}</td>
                        <td
                          className={`px-2 py-1.5 font-semibold sm:px-3 ${row.type === "Income" ? "text-emerald-700" : "text-[#8B0E16]"}`}
                        >
                          {row.amount}
                        </td>
                        <td className="px-2 py-1.5 sm:px-3">
                          <span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] ${statusPill(row.status)}`}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        <section id="features" className="py-8">
          <div className="rounded-3xl border border-slate-700 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-6 shadow-lg shadow-slate-900/20 md:p-8">
            <div className="mb-5 space-y-2">
              <h2 className="text-3xl font-semibold tracking-tight text-white">Replace</h2>
              <p className="max-w-3xl text-base text-slate-200">
                Manual logs, scattered receipts, and your accountant.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {featureCards.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-2xl border border-slate-600 bg-slate-800/80 p-4 shadow-sm shadow-slate-950/20"
                >
                  <div className="flex items-start gap-2">
                    <feature.icon className="mt-0.5 h-5 w-5 shrink-0 text-rose-700" aria-hidden />
                    <h3 className="text-base font-semibold leading-snug text-white">{feature.title}</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-slate-200">{feature.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="ocr" className="py-8">
          <div className="rounded-3xl border border-zinc-200 bg-white p-6 md:p-8">
            <h2 className="text-3xl font-semibold tracking-tight">Organize receipts, track expenses, and generate reports automatically</h2>
            <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-700">
              Capture receipts as you go. Firebook keeps each receipt with the matching transaction so records are easy
              to review. No more searching through papers and emails to find last years donation amounts.
            </p>
          </div>
        </section>

        <section id="reconciliation" className="py-8">
          <div className="grid gap-6 rounded-3xl border border-slate-700 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-6 shadow-lg shadow-slate-900/20 md:p-8 lg:grid-cols-[1fr_0.9fr]">
            <div className="space-y-3">
              <h2 className="text-3xl font-semibold tracking-tight text-white">Reconcile in minutes, not days</h2>
              <p className="text-base leading-relaxed text-slate-200">
                Connect your bank through Plaid or upload a statement. Firebook matches bank activity with receipts
                and flags anything that needs review. No more lapses in funds or missing receipts.
              </p>
            </div>
            <Card className="rounded-2xl border-slate-600 bg-slate-800/85 shadow-md shadow-slate-950/25">
              <CardContent className="space-y-3 p-5 text-sm">
                <div className="flex items-center justify-between border-b border-slate-600 pb-2">
                  <span className="text-slate-300">Total Expenses (Q2)</span>
                  <strong className="text-white">$41,992.12</strong>
                </div>
                <div className="flex items-center justify-between border-b border-slate-600 pb-2">
                  <span className="text-slate-300">Reconciled Rate</span>
                  <strong className="text-sky-300">98.7%</strong>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Needs Review</span>
                  <strong className="text-rose-300">9 items</strong>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section id="reporting" className="py-8">
          <div className="rounded-3xl border border-zinc-200 bg-white p-6 md:p-8">
            <h2 className="text-3xl font-semibold tracking-tight">Reporting you can trust</h2>
            <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-700">
              View spending by category, remaining funds, yearly comparisons, recurring costs, and track
              your funds. Pull reports, documents, and reciepts that are state audit ready in one click.
            </p>
          </div>
        </section>

        <section id="demo" className="py-8">
          <Card className="rounded-3xl border-zinc-300 bg-slate-800 text-slate-100 shadow-md">
            <CardHeader className="border-b border-slate-700">
              <CardTitle className="text-3xl text-white">Request a Demo</CardTitle>
              <CardDescription className="text-slate-200">
                Stop paying for what you already do.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 p-6 md:grid-cols-[1.1fr_0.9fr] md:p-8">
              <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleDemoSubmit}>
                <Input
                  placeholder="Full Name"
                  aria-label="Full Name"
                  name="fullName"
                  required
                  value={demoForm.fullName}
                  onChange={(event) => setDemoForm((current) => ({ ...current, fullName: event.target.value }))}
                  className="border-slate-500 bg-slate-700 text-white placeholder:text-slate-300"
                />
                <Input
                  placeholder="Department Name"
                  aria-label="Department Name"
                  name="departmentName"
                  required
                  value={demoForm.departmentName}
                  onChange={(event) => setDemoForm((current) => ({ ...current, departmentName: event.target.value }))}
                  className="border-slate-500 bg-slate-700 text-white placeholder:text-slate-300"
                />
                <Input
                  placeholder="Phone Number"
                  aria-label="Phone Number"
                  name="phoneNumber"
                  value={demoForm.phoneNumber}
                  onChange={(event) => setDemoForm((current) => ({ ...current, phoneNumber: event.target.value }))}
                  className="border-slate-500 bg-slate-700 text-white placeholder:text-slate-300"
                />
                <Input
                  placeholder="Email"
                  type="email"
                  aria-label="Email"
                  name="email"
                  required
                  value={demoForm.email}
                  onChange={(event) => setDemoForm((current) => ({ ...current, email: event.target.value }))}
                  className="border-slate-500 bg-slate-700 text-white placeholder:text-slate-300"
                />
                <input
                  type="text"
                  name="companyWebsite"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  value={demoForm.companyWebsite}
                  onChange={(event) => setDemoForm((current) => ({ ...current, companyWebsite: event.target.value }))}
                  className="absolute left-[-9999px] h-0 w-0 opacity-0"
                />
                <div className="sm:col-span-2 space-y-2">
                  <Button
                    type="submit"
                    disabled={isSubmittingDemo}
                    className="w-full bg-rose-700 text-white shadow-sm ring-2 ring-rose-200 hover:bg-rose-600 sm:w-auto"
                  >
                    Request Demo
                  </Button>
                  {demoSuccessMessage ? (
                    <p className="text-sm text-emerald-300" role="status">
                      {demoSuccessMessage}
                    </p>
                  ) : null}
                  {demoErrorMessage ? (
                    <p className="text-sm text-rose-300" role="alert">
                      {demoErrorMessage}
                    </p>
                  ) : null}
                </div>
              </form>
              <div className="space-y-3 text-sm text-slate-100">
                <div className="rounded-lg border border-slate-600 bg-slate-700/70 p-3">
                  No more last minute fire drills. Your data is safely stored and protected.
                </div>
                <div className="rounded-lg border border-slate-600 bg-slate-700/70 p-3">
                  No accounting knowledge required.
                </div>
                <div className="rounded-lg border border-slate-600 bg-slate-700/70 p-3">
                  Let us help you so you can help others.
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>

      <PublicFooter />
    </main>
  );
}
