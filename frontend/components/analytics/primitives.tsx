"use client";

/**
 * Small building blocks shared by the Analytics sections.
 *
 * These wrap the existing Hallix card, chip and table styling rather than
 * introducing a parallel component system. Anything that carries a status also
 * carries a word for it, so the meaning survives without colour.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { STATUS_LABELS, statusModifier } from "../../lib/analytics/format";
import type { StatusLevel } from "../../lib/analytics/types";

// ─── Section shell ───────────────────────────────────────────────────────────

export function AnalyticsSection({
  id,
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;

  return (
    <section id={id} className="card fb-an-section" aria-labelledby={headingId}>
      <div className="fb-section-head fb-an-section-head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={headingId}>{title}</h2>
          {description ? <p className="fb-an-section-desc">{description}</p> : null}
        </div>
        {actions ? <div className="fb-an-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

// ─── Status pill ─────────────────────────────────────────────────────────────

export function StatusPill({
  level,
  label,
  size = "default",
}: {
  level: StatusLevel;
  label?: string;
  size?: "default" | "small";
}) {
  return (
    <span
      className={`fb-an-status ${statusModifier(level)} ${size === "small" ? "fb-an-status--sm" : ""}`}
    >
      <span className="fb-an-status-dot" aria-hidden="true" />
      {label ?? STATUS_LABELS[level]}
    </span>
  );
}

// ─── Metric card ─────────────────────────────────────────────────────────────

export function MetricCard({
  label,
  value,
  hint,
  tone,
  change,
  onClick,
  actionLabel,
  info,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "in" | "out" | "warn";
  change?: ReactNode;
  onClick?: () => void;
  actionLabel?: string;
  info?: string;
}) {
  const toneClass =
    tone === "out" ? "fb-metric-value--out" : tone === "warn" ? "fb-metric-value--warn" : "";

  const body = (
    <>
      <p className="fb-metric-label">
        {label}
        {info ? <InfoTip text={info} label={`About ${label}`} /> : null}
      </p>
      <p className={`fb-metric-value ${toneClass}`}>{value}</p>
      {change ? <p className="fb-an-metric-change">{change}</p> : null}
      {hint ? <p className="fb-metric-hint">{hint}</p> : null}
    </>
  );

  if (!onClick) {
    return <div className="fb-metric-card">{body}</div>;
  }

  return (
    <button
      type="button"
      className="fb-metric-card fb-an-metric-card--action"
      onClick={onClick}
      aria-label={actionLabel ?? `${label}. Open related records.`}
    >
      {body}
      <span className="fb-an-metric-cta" aria-hidden="true">
        View →
      </span>
    </button>
  );
}

// ─── Info tooltip ────────────────────────────────────────────────────────────

/**
 * A keyboard-reachable explanation. It toggles on click rather than hover so it
 * works on touch, and the text is always in the DOM for screen readers.
 */
export function InfoTip({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocumentPointerDown(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span className="fb-an-infotip" ref={wrapperRef}>
      <button
        type="button"
        className="fb-an-infotip-btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">i</span>
      </button>
      <span id={panelId} role="note" className={`fb-an-infotip-panel ${open ? "is-open" : ""}`}>
        {text}
      </span>
    </span>
  );
}

// ─── Progress meter ──────────────────────────────────────────────────────────

export function ProgressMeter({
  percent,
  level,
  label,
  markerPercent,
  markerLabel,
}: {
  /** Null means there is no denominator, which is shown as a hatched bar. */
  percent: number | null;
  level: StatusLevel;
  label: string;
  markerPercent?: number | null;
  markerLabel?: string;
}) {
  if (percent == null) {
    return <div className="fb-an-meter fb-an-meter--unknown" role="img" aria-label={`${label}: not available`} />;
  }

  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div
      className="fb-an-meter"
      role="meter"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span className={`fb-an-meter-fill ${statusModifier(level)}`} style={{ width: `${clamped}%` }} />
      {markerPercent != null && markerPercent > 0 && markerPercent <= 100 ? (
        <span
          className="fb-an-meter-marker"
          style={{ left: `${markerPercent}%` }}
          title={markerLabel}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}

// ─── Empty and loading states ────────────────────────────────────────────────

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="fb-an-empty">
      <p className="fb-an-empty-title">{title}</p>
      <p className="fb-an-empty-message">{message}</p>
      {action ? <div className="fb-an-empty-action">{action}</div> : null}
    </div>
  );
}

export function SkeletonBlock({ height = 16, width = "100%" }: { height?: number; width?: string }) {
  return <span className="fb-an-skeleton" style={{ height, width }} aria-hidden="true" />;
}

/**
 * Reserves the same vertical space the loaded section will take, so the page
 * does not jump as each section resolves.
 */
export function SectionSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="fb-an-skeleton-group" role="status" aria-live="polite">
      <span className="fb-an-visually-hidden">{label}</span>
      <SkeletonBlock height={28} width="42%" />
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonBlock key={index} height={56} />
      ))}
    </div>
  );
}

export function MetricSkeletonGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="fb-metric-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="fb-metric-card">
          <SkeletonBlock height={12} width="60%" />
          <SkeletonBlock height={26} width="80%" />
        </div>
      ))}
    </div>
  );
}

// ─── Drawer ──────────────────────────────────────────────────────────────────

/**
 * The single detail surface every Analytics section opens for its "more"
 * content. A side panel on desktop, a full-height sheet on mobile (handled by
 * CSS, not by branching here), so supporting detail always behaves the same
 * way no matter which card it came from.
 *
 * Traps focus, closes on Escape or backdrop click, and returns focus to
 * whatever triggered it — the same contract every call site can rely on.
 */
export function Drawer({
  title,
  eyebrow,
  onClose,
  footer,
  children,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = panel?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? panel)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const node = (
    <div className="fb-an-drawer-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className="fb-an-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fb-an-drawer-head">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h3 id={titleId}>{title}</h3>
          </div>
          <button type="button" className="fb-secondary-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="fb-an-drawer-body">{children}</div>
        {footer ? <div className="fb-an-drawer-foot">{footer}</div> : null}
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}

// ─── Compact strip stat ──────────────────────────────────────────────────────

/**
 * One entry in the compact Department Health strip: a label, a small status
 * dot, and a word or value — never colour alone. Works as a plain item, or as
 * a button when a section wants tapping it to open more detail.
 */
export function MiniStat({
  label,
  value,
  level,
  info,
  onClick,
}: {
  label: string;
  value: ReactNode;
  level: StatusLevel;
  info?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={`fb-an-mini-dot ${statusModifier(level)}`} aria-hidden="true" />
      <span className="fb-an-mini-label">{label}</span>
      <span className="fb-an-mini-value">{value}</span>
    </>
  );

  if (!onClick) {
    return (
      <div className="fb-an-mini-stat">
        {body}
        {info ? <InfoTip text={info} label={`About ${label}`} /> : null}
      </div>
    );
  }

  return (
    <button type="button" className="fb-an-mini-stat fb-an-mini-stat--action" onClick={onClick}>
      {body}
    </button>
  );
}

/** A small "N missing receipts" style badge that links back to the canonical detail. */
export function ExceptionBadge({
  count,
  label,
  onClick,
}: {
  count: number;
  label: string;
  onClick?: () => void;
}) {
  if (count === 0) return null;
  const text = `${count} ${label}`;
  if (!onClick) return <span className="fb-an-exception-badge">{text}</span>;
  return (
    <button type="button" className="fb-an-exception-badge fb-an-exception-badge--action" onClick={onClick}>
      {text}
    </button>
  );
}

// ─── Error state ─────────────────────────────────────────────────────────────

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice notice-error fb-an-error" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="fb-secondary-btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
