"use client";

/* eslint-disable @next/next/no-img-element */
/**
 * Hallix product visuals for the marketing site.
 *
 * The screens are rendered from the real app's navigation (PRIMARY_NAV_ITEMS),
 * dashboard labels, colors, and copy, and scale like a screenshot via container
 * query units. Amounts are illustrative sample data, not company metrics.
 *
 * TODO(marketing): when real captures exist, pass `desktopSrc` / `mobileSrc`
 * (e.g. /marketing/dashboard-desktop.webp at 1600×1000 and
 * /marketing/dashboard-mobile.webp at 390×832) and the image replaces the render.
 */

import { useId, type ReactNode } from "react";
import { ArrowDownLeft, ReceiptText } from "lucide-react";

import { PRIMARY_NAV_ITEMS } from "../../lib/navigation";

function NavIcon({ paths }: { paths: string[] }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const SETTINGS_ICON = [
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
];

const TILE_ICONS = {
  receipt: ["M6 3h12v18l-3-2-3 2-3-2-3 2V3Z", "M9 8h6M9 12h6"],
  moneyIn: ["M12 5v14", "M5 12l7 7 7-7"],
  recon: ["M9 11l3 3L22 4", "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"],
  reports: ["M7 3h8l3 3v15H7V3Z", "M14 3v4h4M9 13h6M9 17h6"],
  statement: ["M4 4h16v16H4z", "M8 9h8M8 13h8M8 17h5"],
};

function DesktopShell({ active, children }: { active: string; children: ReactNode }) {
  return (
    <div className="hx">
      <div className="hx-top">
        <img className="hx-top-logo" src="/logo-light.png" alt="" width={1024} height={207} />
        <div className="hx-search">
          <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          Search transactions, vendors, accounts...
        </div>
        <span className="hx-new">+ New Expense</span>
        <div className="hx-user">
          <div className="hx-user-text">
            <b>Fire Department</b>
            <span>Chief</span>
          </div>
          <span className="hx-avatar">FD</span>
        </div>
      </div>
      <div className="hx-body">
        <div className="hx-side">
          {PRIMARY_NAV_ITEMS.map((item) => (
            <div key={item.id} className={`hx-side-link${item.id === active ? " is-active" : ""}`}>
              <NavIcon paths={item.iconPaths} />
              {item.label}
            </div>
          ))}
          <div className="hx-side-sep" />
          <div className="hx-side-link">
            <NavIcon paths={SETTINGS_ICON} />
            Settings
          </div>
        </div>
        <div className="hx-main">{children}</div>
      </div>
    </div>
  );
}

export function DashboardScreen() {
  return (
    <DesktopShell active="dashboard">
      <div className="hx-card hx-welcome">
        <div className="hx-h1">Welcome back, Chief</div>
        <div className="hx-sub">Here&apos;s what&apos;s happening with your department finances today.</div>
      </div>
      <div className="hx-metrics">
        <div className="hx-card hx-metric">
          <div className="hx-label">Total recorded</div>
          <div className="hx-value">$3,554.04</div>
          <div className="hx-hint">Sum of logged expense amounts</div>
        </div>
        <div className="hx-card hx-metric">
          <div className="hx-label">This month (expenses)</div>
          <div className="hx-value hx-value--out">$1,245.18</div>
          <div className="hx-hint">Based on transaction dates this month</div>
        </div>
        <div className="hx-card hx-metric">
          <div className="hx-label">This month (bank)</div>
          <div className="hx-split">
            <span className="hx-in">In $3,254.51</span>
            <span className="hx-out">Out $1,245.18</span>
          </div>
        </div>
        <div className="hx-card hx-metric">
          <div className="hx-label">Needs attention</div>
          <div className="hx-value">3 review · 2 open</div>
          <div className="hx-hint">Extraction issues plus unreconciled items</div>
        </div>
      </div>
      <div className="hx-card hx-section">
        <div className="hx-section-head">
          <div>
            <div className="hx-eyebrow">Shortcuts</div>
            <div className="hx-h2">Quick actions</div>
          </div>
        </div>
        <div className="hx-quick">
          <QuickTile icon={TILE_ICONS.receipt} tone="red" title="Log with receipt" text="Capture or upload a receipt to extract details." />
          <QuickTile icon={TILE_ICONS.moneyIn} tone="green" title="Record money in" text="Log a deposit, donation, or check." />
          <QuickTile icon={TILE_ICONS.recon} tone="blue" title="Reconciliation report" text="Review matches and export a CSV report." />
          <QuickTile icon={TILE_ICONS.statement} tone="violet" title="Statements" text="Upload statement pages for reconciliation." />
        </div>
      </div>
      <div className="hx-card hx-section">
        <div className="hx-section-head">
          <div>
            <div className="hx-eyebrow">NYS Foreign Fire Insurance</div>
            <div className="hx-h2">
              2% Funds <span className="hx-badge">2% Funds</span>
            </div>
          </div>
          <span className="hx-link">Annual report →</span>
        </div>
        <div className="hx-2pct">
          <div className="hx-metric">
            <div className="hx-label">Account balance</div>
            <div className="hx-value">$8,412.50</div>
          </div>
          <div className="hx-metric">
            <div className="hx-label">2% expenses 2026</div>
            <div className="hx-value hx-value--out">$2,140.00</div>
          </div>
          <div className="hx-metric">
            <div className="hx-label">Annual report</div>
            <div className="hx-value">2026</div>
          </div>
        </div>
      </div>
    </DesktopShell>
  );
}

const TONES = {
  red: { bg: "#fdecec", fg: "#b42318" },
  green: { bg: "#e7f6ee", fg: "#067647" },
  blue: { bg: "#eaf1fe", fg: "#1d4ed8" },
  violet: { bg: "#f1eafe", fg: "#6d28d9" },
} as const;

function QuickTile({
  icon,
  tone,
  title,
  text,
}: {
  icon: string[];
  tone: keyof typeof TONES;
  title: string;
  text?: string;
}) {
  return (
    <div className="hx-tile">
      <span className="hx-tile-icon" style={{ background: TONES[tone].bg, color: TONES[tone].fg }}>
        <NavIcon paths={icon} />
      </span>
      <b>{title}</b>
      {text ? <span>{text}</span> : null}
    </div>
  );
}

export function PhoneDashboardScreen() {
  return (
    <div className="hx hx-phone">
      <div className="hx-status">
        <span>9:41</span>
        <span className="hx-status-icons" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="hx-top">
        <span className="hx-burger" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <img className="hx-top-logo" src="/logo-light.png" alt="" width={1024} height={207} />
        <span className="hx-new">+ New</span>
      </div>
      <div className="hx-main">
        <div className="hx-card hx-welcome">
          <div className="hx-h1">Welcome back, Chief</div>
          <div className="hx-sub">Here&apos;s what&apos;s happening with your department finances today.</div>
        </div>
        <div className="hx-metrics">
          <div className="hx-card hx-metric">
            <div className="hx-label">Total recorded</div>
            <div className="hx-value">$3,554.04</div>
          </div>
          <div className="hx-card hx-metric">
            <div className="hx-label">This month</div>
            <div className="hx-value hx-value--out">$1,245.18</div>
          </div>
          <div className="hx-card hx-metric">
            <div className="hx-label">Needs attention</div>
            <div className="hx-value">3 review</div>
          </div>
          <div className="hx-card hx-metric">
            <div className="hx-label">2% Funds</div>
            <div className="hx-value">$8,412.50</div>
          </div>
        </div>
        <div className="hx-card hx-section">
          <div className="hx-section-head">
            <div className="hx-h2">Quick actions</div>
          </div>
          <div className="hx-quick">
            <QuickTile icon={TILE_ICONS.receipt} tone="red" title="Upload receipt" />
            <QuickTile icon={TILE_ICONS.moneyIn} tone="green" title="Money in" />
            <QuickTile icon={TILE_ICONS.recon} tone="blue" title="Reconcile" />
            <QuickTile icon={TILE_ICONS.reports} tone="violet" title="Reports" />
          </div>
        </div>
        <div className="hx-card hx-section">
          <div className="hx-section-head">
            <div className="hx-h2">Recent activity</div>
          </div>
          {PHONE_ACTIVITY.map((row) => (
            <div key={row.name} className="hx-row">
              <div>
                <b>{row.name}</b>
                <span>{row.kind}</span>
              </div>
              <b className={row.amount.startsWith("+") ? "hx-in" : undefined}>{row.amount}</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const PHONE_ACTIVITY = [
  { name: "Main St. Hardware", kind: "Expense · receipt attached", amount: "-$124.36" },
  { name: "Annual fund drive", kind: "Money In · check", amount: "+$2,500.00" },
  { name: "Fuel — Engine 1", kind: "Expense · matched", amount: "-$89.12" },
] as const;

export function MoneyInScreen() {
  return (
    <DesktopShell active="transactions">
      <div className="hx-card hx-section">
        <div className="hx-eyebrow">New entry</div>
        <div className="hx-h1" style={{ fontSize: "1.9em", marginTop: "0.2em" }}>
          Record money in
        </div>
        <div className="hx-sub">Is this money in or money out?</div>
        <div className="hx-quick" style={{ gridTemplateColumns: "1fr 1fr", marginTop: "1em" }}>
          <div className="hx-tile" style={{ flexDirection: "row", alignItems: "center", gap: "0.7em" }}>
            <Radio />
            <b>Money out</b>
            <span>(expense, check, fee)</span>
          </div>
          <div
            className="hx-tile"
            style={{ flexDirection: "row", alignItems: "center", gap: "0.7em", borderColor: "#067647", background: "#e7f6ee" }}
          >
            <Radio checked />
            <b>Money in</b>
            <span>(deposit, interest, refund)</span>
          </div>
        </div>
      </div>
      <div className="hx-card hx-section">
        <div className="hx-2pct" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          <Field label="Amount" value="$2,500.00" tone="in" />
          <Field label="Date" value="Apr 14, 2026" />
          <Field label="Received from" value="Annual fund drive" />
          <Field label="Category" value="Donations" />
          <Field label="Payment" value="Check #1042" />
          <Field label="Account" value="Operating checking" />
        </div>
      </div>
    </DesktopShell>
  );
}

function Radio({ checked = false }: { checked?: boolean }) {
  return (
    <span
      style={{
        width: "1.2em",
        height: "1.2em",
        borderRadius: 999,
        border: `0.2em solid ${checked ? "#067647" : "#cbd5e1"}`,
        background: checked ? "radial-gradient(circle, #067647 40%, #fff 45%)" : "#fff",
        flexShrink: 0,
      }}
    />
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: "in" }) {
  return (
    <div className="hx-metric">
      <div className="hx-label">{label}</div>
      <div className="hx-value" style={{ fontSize: "1.3em", color: tone === "in" ? "#067647" : undefined }}>
        {value}
      </div>
    </div>
  );
}

const RECON_ROWS = [
  { name: "Main St. Hardware", date: "Apr 14", amount: "-$124.36", status: "Receipt text sent", tone: "amber" },
  { name: "NYS 2% distribution", date: "Apr 12", amount: "+$8,250.00", status: "Matched", tone: "green" },
  { name: "Fuel — Engine 1", date: "Apr 10", amount: "-$89.12", status: "Matched", tone: "green" },
  { name: "Uniform supplier", date: "Apr 08", amount: "-$620.00", status: "Needs review", tone: "red" },
  { name: "Member dues", date: "Apr 05", amount: "+$400.00", status: "Matched", tone: "green" },
] as const;

const STATUS_TONE = {
  green: { bg: "#e7f6ee", fg: "#067647" },
  amber: { bg: "#fdf2e9", fg: "#9a3412" },
  red: { bg: "#fdecec", fg: "#b42318" },
} as const;

export function ReconciliationScreen() {
  return (
    <DesktopShell active="reconciliation">
      <div className="hx-card hx-section">
        <div className="hx-section-head">
          <div>
            <div className="hx-eyebrow">Bank activity</div>
            <div className="hx-h2">Reconciliation</div>
          </div>
          <span className="hx-link">Upload statement →</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {RECON_ROWS.map((row) => (
            <div
              key={row.name}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                alignItems: "center",
                gap: "1.2em",
                padding: "0.85em 0",
                borderTop: "1px solid #eef1f5",
                fontSize: "1.1em",
              }}
            >
              <div>
                <b>{row.name}</b>
                <div style={{ color: "#5c6578", fontSize: "0.85em" }}>{row.date}, 2026</div>
              </div>
              <span
                style={{
                  padding: "0.25em 0.75em",
                  borderRadius: 999,
                  fontSize: "0.78em",
                  fontWeight: 800,
                  background: STATUS_TONE[row.tone].bg,
                  color: STATUS_TONE[row.tone].fg,
                  whiteSpace: "nowrap",
                }}
              >
                {row.status}
              </span>
              <b style={{ color: row.amount.startsWith("+") ? "#067647" : "#101828", minWidth: "6.5em", textAlign: "right" }}>
                {row.amount}
              </b>
            </div>
          ))}
        </div>
      </div>
    </DesktopShell>
  );
}

type HeroDevicesProps = {
  desktopSrc?: string;
  mobileSrc?: string;
};

export function HeroDevices({ desktopSrc, mobileSrc }: HeroDevicesProps) {
  return (
    <figure className="mkt-devices" style={{ margin: 0 }}>
      <div className="mkt-laptop">
        <div className="mkt-laptop-lid">
          <div className="mkt-screen">
            {desktopSrc ? (
              <img src={desktopSrc} alt="Hallix dashboard on a laptop" width={1600} height={1000} />
            ) : (
              <DashboardScreen />
            )}
          </div>
        </div>
        <div className="mkt-laptop-base" aria-hidden />
      </div>

      <div className="mkt-phone">
        <div className="mkt-phone-screen">
          <span className="mkt-phone-notch" aria-hidden />
          {mobileSrc ? (
            <img src={mobileSrc} alt="Hallix dashboard on a phone" width={390} height={832} />
          ) : (
            <PhoneDashboardScreen />
          )}
        </div>
      </div>

      <div className="mkt-chip mkt-chip--receipt" aria-hidden>
        <span className="mkt-chip-icon">
          <ReceiptText size={14} strokeWidth={2.5} />
        </span>
        Receipt received
      </div>
      <div className="mkt-chip mkt-chip--money" aria-hidden>
        <span className="mkt-chip-icon">
          <ArrowDownLeft size={14} strokeWidth={2.75} />
        </span>
        Money In recorded
      </div>

      <figcaption className="mkt-sr-only">
        The Hallix dashboard on a laptop and phone, showing totals, quick actions, and the 2% Funds balance.
      </figcaption>
    </figure>
  );
}

/** Decorative night-time firehouse silhouette used behind dark sections. */
export function FirehouseBackdrop() {
  const uid = useId().replace(/:/g, "");
  const id = (name: string) => `${name}-${uid}`;
  const url = (name: string) => `url(#${id(name)})`;

  return (
    <div className="mkt-backdrop" aria-hidden>
      <svg viewBox="0 0 1600 720" preserveAspectRatio="xMaxYMax slice" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id={id("bay")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f6b24a" stopOpacity="0.5" />
            <stop offset="0.55" stopColor="#b8582c" stopOpacity="0.22" />
            <stop offset="1" stopColor="#1b130e" stopOpacity="0.2" />
          </linearGradient>
          <linearGradient id={id("wall")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#16213a" />
            <stop offset="1" stopColor="#0c1326" />
          </linearGradient>
          <radialGradient id={id("floor")} cx="0.5" cy="0" r="0.6">
            <stop offset="0" stopColor="#f59e0b" stopOpacity="0.22" />
            <stop offset="1" stopColor="#f59e0b" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={id("beacon")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ff4b4b" stopOpacity="0.9" />
            <stop offset="1" stopColor="#ff4b4b" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g fill="#0d1629">
          <polygon points="760,640 800,470 840,640" />
          <polygon points="820,640 868,420 916,640" />
          <polygon points="890,640 930,500 970,640" />
          <polygon points="950,640 990,450 1030,640" />
        </g>

        <rect x="1040" y="330" width="440" height="310" fill={url("wall")} />
        <rect x="1028" y="316" width="464" height="18" fill="#101a30" />
        <rect x="1470" y="200" width="96" height="440" fill="#111b31" />
        <rect x="1462" y="190" width="112" height="14" fill="#14203a" />
        <rect x="1500" y="240" width="36" height="52" rx="4" fill="#f6b24a" fillOpacity="0.16" />
        <rect x="1080" y="348" width="360" height="30" rx="3" fill="#0b1222" />

        {[1068, 1206, 1344].map((x) => (
          <g key={x}>
            <path d={`M${x} 620 V430 a62 26 0 0 1 124 0 V620 Z`} fill={url("bay")} />
            {[460, 490, 520, 550, 580].map((y) => (
              <rect key={y} x={x} y={y} width="124" height="2" fill="#0b1222" fillOpacity="0.35" />
            ))}
          </g>
        ))}

        <g>
          <path d="M1214 616 V548 h70 l20 -30 h52 l24 40 V616 Z" fill="#2d0d12" fillOpacity="0.9" />
          <rect x="1312" y="526" width="36" height="22" rx="3" fill="#f6b24a" fillOpacity="0.28" />
          <rect x="1222" y="560" width="120" height="6" fill="#d9a441" fillOpacity="0.35" />
          <circle cx="1246" cy="616" r="14" fill="#0a0f1c" />
          <circle cx="1350" cy="616" r="14" fill="#0a0f1c" />
          <rect x="1318" y="510" width="26" height="8" rx="3" fill="#ff4b4b" fillOpacity="0.85" />
          <circle cx="1331" cy="514" r="34" fill={url("beacon")} />
        </g>

        <rect x="0" y="636" width="1600" height="84" fill="#070b16" fillOpacity="0.55" />
        <ellipse cx="1260" cy="640" rx="260" ry="46" fill={url("floor")} />

        <g fill="#0a1222">
          <polygon points="1560,640 1590,520 1620,640" />
        </g>
      </svg>
    </div>
  );
}
