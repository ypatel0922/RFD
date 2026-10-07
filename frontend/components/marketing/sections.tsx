"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  ArrowRight,
  BarChart3,
  Check,
  ClipboardCheck,
  FileSpreadsheet,
  FolderLock,
  Landmark,
  Lock,
  MessageSquareText,
  Percent,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
  UserCheck,
  Users,
} from "lucide-react";
import Link from "next/link";

import {
  DashboardScreen,
  FirehouseBackdrop,
  HeroDevices,
  MoneyInScreen,
  ReconciliationScreen,
} from "./product-frames";
import { Reveal } from "./reveal";

function useInViewOnce<T extends HTMLElement>(threshold = 0.25) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, visible };
}

const VALUE_CHECKS = ["Easier", "Cheaper", "Smarter", "Safer"] as const;

function CheckList({ items, className = "" }: { items: readonly string[]; className?: string }) {
  return (
    <ul className={`mkt-checks ${className}`.trim()}>
      {items.map((item) => (
        <li key={item}>
          <span className="mkt-check" aria-hidden>
            <Check size={14} strokeWidth={3.25} />
          </span>
          {item}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ Hero */

export function MarketingHero() {
  return (
    <section className="mkt-hero" id="product" aria-labelledby="mkt-hero-heading">
      <FirehouseBackdrop />
      <div className="mkt-container mkt-hero-grid">
        <div className="mkt-hero-copy">
          <p className="mkt-eyebrow">Built for fire departments</p>
          <h1 id="mkt-hero-heading">
            Stop chasing <br className="mkt-br-m" />
            fires in <br className="mkt-br-d" />
            your <br className="mkt-br-m" />
            finances,{" "}
            <span className="mkt-accent">
              let us <br />
              keep everything <br className="mkt-br-m" />
              contained.
            </span>
          </h1>
          <p className="mkt-hero-lede">
            Hallix replaces manual logs, scattered receipts, and your accountant, while keeping your department audit-ready.
          </p>
          <p className="mkt-built-by">
            <span className="mkt-built-by-icon" aria-hidden>
              <ShieldCheck size={16} strokeWidth={2.5} />
            </span>
            Built by a firefighter, accountant, and lawyer.
          </p>
          <div className="mkt-hero-ctas">
            <a href="#demo" className="mkt-btn mkt-btn-primary mkt-btn-pulse">
              Request a demo
              <ArrowRight size={18} className="mkt-arrow" aria-hidden />
            </a>
            <Link href="/login" className="mkt-btn mkt-btn-ghost">
              Sign In
            </Link>
          </div>
          <CheckList items={VALUE_CHECKS} />
        </div>
        <div className="mkt-hero-visual">
          <HeroDevices />
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- Trust strip */

const TRUST_ITEMS = [
  {
    title: "Transparency & Analysis",
    text: "Automatic reconciliation, AI insights, easy searches, and side-by-side comparisons.",
    icon: BarChart3,
  },
  {
    title: "Plaid or Manual",
    text: "Every account in one place — connected or entered by hand.",
    icon: Landmark,
  },
  {
    title: "Secure Records",
    text: "Receipts and documents stored safely, ready for any report.",
    icon: FolderLock,
  },
  {
    title: "Compliance & audit-ready",
    text: "Automatically generate tax forms and activity logs.",
    icon: ClipboardCheck,
  },
] as const;

export function TrustStrip() {
  return (
    <section className="mkt-trust" aria-label="Why departments choose Hallix">
      <div className="mkt-container">
        <div className="mkt-trust-card">
          {TRUST_ITEMS.map((item) => (
            <div key={item.title} className="mkt-trust-item">
              <span className="mkt-trust-icon" aria-hidden>
                <item.icon size={20} strokeWidth={2.1} />
              </span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- Features */

const FEATURES = [
  {
    title: "Upload & Save Receipts & Documents",
    text: "Snap or upload a receipt. Hallix reads the details and files it with the transaction. No need to log it yourself",
    icon: Upload,
    bg: "#fdecec",
    fg: "#c81e2a",
  },
  {
    title: "Generate Tax Forms and Spending Reports",
    text: "NYS 2% support, plus spending, vendor, and yearly reports in a click so you are ready for your meetings.",
    icon: FileSpreadsheet,
    bg: "#e7f6ee",
    fg: "#067647",
  },
  {
    title: "Text-message Reminders & Receipt Upload",
    text: "Users recieve a text when transactions post. Simply text a photo of the receipt back and Hallix attaches it automatically.",
    icon: MessageSquareText,
    bg: "#eaf1fe",
    fg: "#1d4ed8",
  },
  {
    title: "Easy Compliance & Audit-ready Reports",
    text: "Keep receipts, reports, transactions, and required records organized in one place. Stay ready without the paperwork.",
    icon: ShieldCheck,
    bg: "#f1eafe",
    fg: "#6d28d9",
  },
  {
    title: "NYS 2% Fund Intelligence",
    text: "Track spending, documentation, and reporting ensuring no misuse of funds — built around NY fire department needs.",
    icon: Percent,
    bg: "#fdecec",
    fg: "#c81e2a",
  },
  {
    title: "Reconciliation & Matching",
    text: "Match bank activity to receipts and statements for full transparency, with analytics on where every dollar goes. No more chasing down receipts.",
    icon: RefreshCw,
    bg: "#eaf1fe",
    fg: "#1d4ed8",
  },
] as const;

export function FeaturesSection() {
  return (
    <section id="features" className="mkt-section mkt-features" aria-labelledby="features-heading">
      <div className="mkt-container">
        <div className="mkt-head">
          <h2 id="features-heading" className="mkt-h2">
            Stop spending thousands on accountants.
          </h2>
        </div>
        <div className="mkt-feature-grid">
          {FEATURES.map((feature) => (
            <Reveal key={feature.title} as="article" className="mkt-feature">
              <span className="mkt-feature-icon" style={{ background: feature.bg, color: feature.fg }} aria-hidden>
                <feature.icon size={21} strokeWidth={2.2} />
              </span>
              <div className="mkt-feature-body">
                <h3>
                  {feature.title}
                  <ArrowRight size={16} aria-hidden />
                </h3>
                <p>{feature.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------- Text receipt flow */

function FlowArrow({ index }: { index: 1 | 2 }) {
  return (
    <div className={`mkt-flow-arrow mkt-flow-arrow--${index}`} aria-hidden>
      <svg viewBox="0 0 36 24" fill="none">
        <g className="mkt-draw">
          <path d="M2 12h24" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeDasharray="1 5" />
          <path d="M24 6l7 6-7 6" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
    </div>
  );
}

function SmsChrome({ children }: { children: ReactNode }) {
  return (
    <div className="mkt-mini-phone">
      <div className="mkt-mini-screen">
        <div className="sms">
          <div className="sms-status">
            <span>9:41</span>
            <span>●●●</span>
          </div>
          <div className="sms-head">
            <span className="sms-avatar">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.png" alt="" width={261} height={261} />
            </span>
            Hallix
          </div>
          <div className="sms-thread">{children}</div>
        </div>
      </div>
    </div>
  );
}

function ReceiptPhoto() {
  return (
    <div className="sms-photo">
      <div className="receipt">
        <div className="receipt-store">MAIN ST. HARDWARE</div>
        <div className="receipt-meta">04/14/2026 · 10:32 AM</div>
        <div className="receipt-row">
          <span>Hose fittings</span>
          <span>48.90</span>
        </div>
        <div className="receipt-row">
          <span>Shop rags (2)</span>
          <span>21.98</span>
        </div>
        <div className="receipt-row">
          <span>Flashlight</span>
          <span>44.36</span>
        </div>
        <div className="receipt-rule" />
        <div className="receipt-row">
          <span>Tax</span>
          <span>9.12</span>
        </div>
        <div className="receipt-row receipt-total">
          <span>TOTAL</span>
          <span>$124.36</span>
        </div>
        <div className="receipt-bars" />
      </div>
    </div>
  );
}

export function TextReceiptWorkflow() {
  const { ref, visible } = useInViewOnce<HTMLDivElement>(0.3);

  return (
    <section id="text-receipts" className="mkt-section mkt-sms-section mkt-glow-band" aria-labelledby="sms-heading">
      <div className="mkt-container">
        <div className="mkt-sms">
          <div className="mkt-sms-copy">
            <p className="mkt-label">Receipts in seconds</p>
            <h2 id="sms-heading" className="mkt-h2">
              Just text it. We&apos;ll take care of the rest.
            </h2>
            <p className="mkt-sub">
              Text a photo of your receipt and we&apos;ll automatically extract the details, categorize
              it, and file it for you.
            </p>
            <a href="#demo" className="mkt-btn mkt-btn-primary">
              See it in action
              <ArrowRight size={18} className="mkt-arrow" aria-hidden />
            </a>
          </div>

          <div ref={ref} className={`mkt-flow${visible ? " is-visible" : ""}`}>
            <div className="mkt-flow-step mkt-flow-step--1">
              <div className="mkt-flow-head">
                <span className="mkt-flow-num">1</span>
                <div>
                  <h3>Get a reminder</h3>
                  <p>Hallix will remind you to send missing receipts.</p>
                </div>
              </div>
              <div className="mkt-flow-visual">
                <SmsChrome>
                  <span className="sms-time">Today 2:14 PM</span>
                  <div className="sms-in">
                    Hallix: Receipt needed for $124.36 at Main St. Hardware on Apr 14. Reply with a photo of the
                    receipt.
                  </div>
                </SmsChrome>
              </div>
            </div>

            <FlowArrow index={1} />

            <div className="mkt-flow-step mkt-flow-step--2">
              <div className="mkt-flow-head">
                <span className="mkt-flow-num">2</span>
                <div>
                  <h3>Text your receipt</h3>
                  <p>Reply with a photo.</p>
                </div>
              </div>
              <div className="mkt-flow-visual">
                <SmsChrome>
                  <div className="sms-out">
                    <ReceiptPhoto />
                  </div>
                  <span className="sms-delivered">Delivered</span>
                </SmsChrome>
              </div>
            </div>

            <FlowArrow index={2} />

            <div className="mkt-flow-step mkt-flow-step--3">
              <div className="mkt-flow-head">
                <span className="mkt-flow-num">3</span>
                <div>
                  <h3>It&apos;s logged automatically</h3>
                  <p>Hallix captures the details and updates the record.</p>
                </div>
              </div>
              <div className="mkt-flow-visual">
                <div className="mkt-confirm">
                  <div className="mkt-confirm-top">
                    <span className="mkt-confirm-logo" aria-hidden>
                      MS
                    </span>
                    <div>
                      <div className="mkt-confirm-name">Main St. Hardware</div>
                      <div className="mkt-confirm-date">Apr 14, 2026</div>
                    </div>
                    <span className="mkt-confirm-check" aria-hidden>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </div>
                  <div className="mkt-confirm-mid">
                    <span className="mkt-tag">Expense</span>
                    <span className="mkt-confirm-amt">-$124.36</span>
                  </div>
                  <div className="mkt-confirm-fields">
                    <div>
                      <span>Vendor</span>
                      <b>Main St. Hardware</b>
                    </div>
                    <div>
                      <span>Tax</span>
                      <b>$9.12</b>
                    </div>
                    <div>
                      <span>Category</span>
                      <b>Equipment</b>
                    </div>
                    <div>
                      <span>Receipt</span>
                      <b>Attached</b>
                    </div>
                  </div>
                  <div className="mkt-confirm-foot">
                    <Check size={16} strokeWidth={3} aria-hidden />
                    Receipt received. You&apos;re all set.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- How it works */

const STEPS = [
  { title: "Set up your department", text: "Connect your bank accounts with Plaid or work manually." },
  { title: "Capture your records", text: "Start uploading receipts and receive text reminders." },
  { title: "Stay organized", text: "Reconcile accounts, track 2% funds, generate reports, and file your tax forms." },
] as const;

export function HowItWorks() {
  const { ref, visible } = useInViewOnce<HTMLOListElement>(0.35);

  return (
    <section id="how-it-works" className="mkt-section mkt-how" aria-labelledby="how-heading">
      <div className="mkt-container">
        <div className="mkt-head mkt-how-head">
          <h2 id="how-heading" className="mkt-h2">
            How it works
          </h2>
          <p className="mkt-sub">No complicated setup. We&apos;ll walk you through the process.</p>
        </div>
        <ol ref={ref} className={`mkt-steps${visible ? " is-visible" : ""}`}>
          {STEPS.flatMap((step, index) => {
            const n = index + 1;
            const item = (
              <li key={step.title} className={`mkt-step mkt-step--${n}`}>
                <span className="mkt-step-num" aria-hidden>
                  {n}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </li>
            );
            if (index === STEPS.length - 1) return [item];
            return [
              item,
              <li key={`${step.title}-arrow`} className={`mkt-step-arrow mkt-step-arrow--${n}`} aria-hidden>
                <ArrowRight size={20} strokeWidth={2.4} />
              </li>,
            ];
          })}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ Demo cards */

// TODO(marketing): add `videoSrc` to an entry when a recorded walkthrough exists
// and render it in the media slot with <video controls preload="none">.
const DEMOS = [
  {
    title: "Dashboard",
    text: "See your department's financial position at a glance.",
    href: "#product",
    Screen: DashboardScreen,
  },
  {
    title: "Search & Analyze",
    text: "Look for past donations and expenses in seconds.",
    href: "#how-it-works",
    Screen: MoneyInScreen,
  },
  {
    title: "2% Reports",
    text: "Automatically generate your annual 2% report.",
    href: "#text-receipts",
    Screen: ReconciliationScreen,
  },
] as const;

export function ProductDemoSection() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  function handleScroll() {
    const track = trackRef.current;
    const first = track?.firstElementChild as HTMLElement | null;
    if (!track || !first) return;
    const step = first.offsetWidth + 14;
    setActive(Math.min(DEMOS.length - 1, Math.max(0, Math.round(track.scrollLeft / step))));
  }

  return (
    <section id="see-hallix" className="mkt-section" style={{ paddingTop: 0 }} aria-labelledby="demos-heading">
      <div className="mkt-container">
        <div className="mkt-head">
          <h2 id="demos-heading" className="mkt-h2">
            See Hallix in action
          </h2>
          <p className="mkt-sub">Take a quick look at how Hallix works for your department.</p>
        </div>
        <div ref={trackRef} className="mkt-demos" onScroll={handleScroll}>
          {DEMOS.map(({ title, text, href, Screen }) => (
            <article key={title} className="mkt-demo">
              <a href={href} className="mkt-demo-media" tabIndex={-1} aria-hidden>
                <div className="mkt-demo-frame">
                  <div className="mkt-screen">
                    <Screen />
                  </div>
                </div>
                <span className="mkt-demo-play">
                  <Play size={22} fill="currentColor" strokeWidth={0} />
                </span>
              </a>
              <div className="mkt-demo-body">
                <h3>{title}</h3>
                <p>{text}</p>
                <a href={href} className="mkt-demo-link">
                  View workflow
                  <ArrowRight size={16} aria-hidden />
                  <span className="mkt-sr-only">: {title}</span>
                </a>
              </div>
            </article>
          ))}
        </div>
        <div className="mkt-demo-dots" aria-hidden>
          {DEMOS.map((demo, index) => (
            <span key={demo.title} className={index === active ? "is-active" : undefined} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- Founder trust */

// TODO(marketing): set to the real founder photo (e.g. { src: "/marketing/founder.webp", alt: "..." })
// once one is provided. Never substitute a stock or generated portrait.
const FOUNDER_PHOTO: { src: string; alt: string } | null = null;

export function FounderTrust() {
  return (
    <section id="about" className="mkt-section mkt-founder-section mkt-glow-band" aria-labelledby="about-heading">
      <div className="mkt-container">
        <div className="mkt-founder">
          <div className="mkt-founder-copy">
            <p className="mkt-label">Built on real-world experience</p>
            <h2 id="about-heading" className="mkt-h2">
              Built by a firefighter, <br />
              accountant, and lawyer.
            </h2>
            <p>
              Hallix was created from years of firsthand experience with fire department operations — so it fits the way departments and companies actually work.
            </p>
            <ul className="mkt-roles" aria-label="Founding experience">
              <li>Firefighter</li>
              <li>Accountant</li>
              <li>Lawyer</li>
            </ul>
          </div>

          <div className={`mkt-founder-photo${FOUNDER_PHOTO ? "" : " is-placeholder"}`}>
            {FOUNDER_PHOTO ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={FOUNDER_PHOTO.src}
                alt={FOUNDER_PHOTO.alt}
                loading="lazy"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="mkt-founder-mark" src="/icon.png" alt="" width={261} height={261} />
                <span>Hallix</span>
              </>
            )}
          </div>

          <blockquote className="mkt-quote">
            <span className="mkt-quote-mark mkt-quote-mark--open" aria-hidden>
              &ldquo;
            </span>
            <p>
              Department finances shouldn&apos;t feel complicated. Hallix gives you the
              tools, clarity, and confidence to handle your&nbsp;money.
            </p>
            <span className="mkt-quote-mark mkt-quote-mark--close" aria-hidden>
              &rdquo;
            </span>
            <footer>
              <cite className="mkt-quote-name">Yash Patel</cite>
              <span className="mkt-quote-role">Founder &amp; Lieutenant</span>
            </footer>
          </blockquote>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------- Security + pricing row */

const SECURITY_ITEMS = [
  { title: "Private department records", text: "Your financial data stays in your department's workspace.", icon: Lock },
  { title: "Role-based access", text: "Invite trusted members and control who can do what.", icon: UserCheck },
  { title: "Secure bank connections", text: "Connect through Plaid, or keep everything manual.", icon: Users },
] as const;

export function SecurityAndPricing() {
  return (
    <section className="mkt-section" style={{ paddingTop: 0 }} aria-label="Security and pricing">
      <div className="mkt-container mkt-assure">
        <div id="security" className="mkt-assure-card">
          <h2>Security that keeps you in control.</h2>
          <p>Private records. Clear access. Bank connections you control.</p>
          <ul className="mkt-assure-list">
            {SECURITY_ITEMS.map((item) => (
              <li key={item.title}>
                <span className="mkt-trust-icon" aria-hidden>
                  <item.icon size={18} strokeWidth={2.2} />
                </span>
                <div>
                  <b>{item.title}</b>
                  <span>{item.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div id="pricing" className="mkt-assure-card mkt-pricing">
          <h2>Pricing that fits your department.</h2>
          <p>Every department is different. We&apos;ll walk through your workflow and budget in a short demo.</p>
          <a href="#demo" className="mkt-btn mkt-btn-primary">
            Request pricing
            <ArrowRight size={18} className="mkt-arrow" aria-hidden />
          </a>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------- Final CTA + demo request */

const initialDemoForm = {
  fullName: "",
  departmentName: "",
  phoneNumber: "",
  email: "",
  companyWebsite: "",
};

export function FinalCta() {
  const [demoForm, setDemoForm] = useState(initialDemoForm);
  const [isSubmittingDemo, setIsSubmittingDemo] = useState(false);
  const [demoSuccessMessage, setDemoSuccessMessage] = useState("");
  const [demoErrorMessage, setDemoErrorMessage] = useState("");

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

  function update(field: keyof typeof initialDemoForm) {
    return (event: ChangeEvent<HTMLInputElement>) =>
      setDemoForm((current) => ({ ...current, [field]: event.target.value }));
  }

  return (
    <section id="demo" className="mkt-final" aria-labelledby="final-heading">
      <FirehouseBackdrop />
      <div className="mkt-container mkt-final-grid">
        <div>
          <p className="mkt-label">Ready to simplify your department finances?</p>
          <h2 id="final-heading" className="mkt-h2">
            Stop paying for what you already do.
          </h2>
          <p className="mkt-sub">
            See how Hallix can help your department spend less time on paperwork and more time serving your
            community.
          </p>
          <CheckList
            items={["No accounting knowledge required", "Just a short demo", "Built for those who serve"]}
            className="mkt-final-checks"
          />
        </div>

        <form className="mkt-form" onSubmit={handleDemoSubmit}>
          <h3>Request a demo</h3>
          <div className="mkt-form-fields">
            <label className="mkt-field">
              Full name
              <input name="fullName" autoComplete="name" required value={demoForm.fullName} onChange={update("fullName")} />
            </label>
            <label className="mkt-field">
              Department name
              <input
                name="departmentName"
                autoComplete="organization"
                required
                value={demoForm.departmentName}
                onChange={update("departmentName")}
              />
            </label>
            <label className="mkt-field">
              Phone number
              <input
                name="phoneNumber"
                type="tel"
                autoComplete="tel"
                value={demoForm.phoneNumber}
                onChange={update("phoneNumber")}
              />
            </label>
            <label className="mkt-field">
              Email
              <input name="email" type="email" autoComplete="email" required value={demoForm.email} onChange={update("email")} />
            </label>
          </div>
          <input
            type="text"
            name="companyWebsite"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="mkt-honeypot"
            value={demoForm.companyWebsite}
            onChange={update("companyWebsite")}
          />
          <button type="submit" className="mkt-btn mkt-btn-primary" disabled={isSubmittingDemo}>
            {isSubmittingDemo ? "Sending…" : "Request Demo"}
            {isSubmittingDemo ? null : <ArrowRight size={18} className="mkt-arrow" aria-hidden />}
          </button>
          {demoSuccessMessage ? (
            <p className="mkt-status-ok" role="status">
              {demoSuccessMessage}
            </p>
          ) : null}
          {demoErrorMessage ? (
            <p className="mkt-status-err" role="alert">
              {demoErrorMessage}
            </p>
          ) : null}
          <p className="mkt-form-note">We have answers to your questions.</p>
        </form>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Footer */

export function MarketingFooter() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-container mkt-footer-inner">
        <nav className="mkt-footer-links" aria-label="Footer">
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
          <a href="/sms-policy">SMS Policy</a>
        </nav>
        <p>© {new Date().getFullYear()} Hallix for Fire Departments</p>
      </div>
    </footer>
  );
}
