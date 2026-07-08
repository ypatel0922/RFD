"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { supabase, taxFormsBucket } from "../lib/supabase";
import { logAuditFromBrowser } from "../lib/audit";
import type { DepartmentMembership, TaxFormFiling } from "../lib/types";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function sourceLabel(source: TaxFormFiling["source"]): string {
  return source === "generated_firebook"
    ? "Generated in Firebook"
    : "Uploaded prior filing";
}

function statusLabel(status: TaxFormFiling["status"]): string {
  const m: Record<TaxFormFiling["status"], string> = {
    draft:    "Draft",
    saved:    "Saved",
    uploaded: "Uploaded",
    archived: "Archived",
  };
  return m[status] ?? status;
}

function isImage(mimeType: string | null | undefined): boolean {
  return !!mimeType?.startsWith("image/");
}

async function getSignedUrl(path: string, ttlSeconds = 3600): Promise<string | null> {
  const { data } = await supabase.storage
    .from(taxFormsBucket)
    .createSignedUrl(path, ttlSeconds);
  return data?.signedUrl ?? null;
}

// ─────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────

export function TaxFormFilingsSection({
  membership,
  refreshKey,
}: {
  membership: DepartmentMembership;
  /** Bump to force a re-fetch (e.g., after returning from the report builder) */
  refreshKey: number;
}) {
  const [filings, setFilings] = useState<TaxFormFiling[]>([]);
  const [loading, setLoading] = useState(true);

  // View modal
  const [viewFiling, setViewFiling] = useState<TaxFormFiling | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  // Replace upload
  const [replaceTarget, setReplaceTarget] = useState<TaxFormFiling | null>(null);
  const [isReplacing, setIsReplacing] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Archive
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const departmentId = membership.department_id;

  // ── Load filings ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    supabase
      .from("tax_form_filings")
      .select("*")
      .eq("department_id", departmentId)
      .eq("tax_form_type", "nys_foreign_fire_insurance")
      .neq("status", "archived")
      .order("tax_year", { ascending: false })
      .order("updated_at", { ascending: false })
      .then(({ data }) => {
        if (!cancelled) {
          setFilings((data as TaxFormFiling[]) ?? []);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [departmentId, refreshKey]);

  // ── View filing ─────────────────────────────────────────
  async function handleView(filing: TaxFormFiling) {
    setViewFiling(filing);
    setViewUrl(null);
    if (filing.file_path) {
      setViewLoading(true);
      const url = await getSignedUrl(filing.file_path);
      setViewUrl(url);
      setViewLoading(false);
    }
  }

  function handleCloseView() {
    setViewFiling(null);
    setViewUrl(null);
  }

  // ── Download filing ─────────────────────────────────────
  async function handleDownload(filing: TaxFormFiling) {
    if (!filing.file_path) return;
    const url = await getSignedUrl(filing.file_path, 60);
    if (url) {
      const a = document.createElement("a");
      a.href = url;
      a.download = filing.file_name || `nys-2pct-${filing.tax_year}.pdf`;
      a.click();
    }
    void logAuditFromBrowser({
      departmentId,
      userRole: membership.role,
      action: "report.downloaded",
      resourceType: "tax_filing",
      resourceId: filing.id,
      resourceLabel: `${filing.tax_year} ${sourceLabel(filing.source)}`,
      metadata: { taxYear: filing.tax_year, source: filing.source },
    });
  }

  // ── Replace uploaded filing ─────────────────────────────
  function handleReplaceClick(filing: TaxFormFiling) {
    setReplaceTarget(filing);
    setTimeout(() => replaceInputRef.current?.click(), 50);
  }

  async function handleReplaceFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (replaceInputRef.current) replaceInputRef.current.value = "";
    if (!file || !replaceTarget) return;

    const confirmed = window.confirm(
      `Replace the ${replaceTarget.tax_year} prior filing with "${file.name}"?\n\nThe existing file will be overwritten.`,
    );
    if (!confirmed) {
      setReplaceTarget(null);
      return;
    }

    setIsReplacing(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "pdf";
      const newPath = `${departmentId}/nys-2-percent/${replaceTarget.tax_year}/prior-upload.${ext}`;

      // Delete old file if the path changed (different extension)
      if (replaceTarget.file_path && replaceTarget.file_path !== newPath) {
        await supabase.storage.from(taxFormsBucket).remove([replaceTarget.file_path]);
      }

      // Upload new file (upsert in case same path)
      await supabase.storage.from(taxFormsBucket).upload(newPath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: true,
      });

      // Update filing record
      const now = new Date().toISOString();
      await supabase
        .from("tax_form_filings")
        .update({
          file_path:      newPath,
          file_name:      file.name,
          file_mime_type: file.type || "application/octet-stream",
          updated_at:     now,
        })
        .eq("id", replaceTarget.id);

      setFilings((prev) =>
        prev.map((f) =>
          f.id === replaceTarget.id
            ? { ...f, file_path: newPath, file_name: file.name,
                file_mime_type: file.type || null, updated_at: now }
            : f,
        ),
      );
      void logAuditFromBrowser({
        departmentId,
        userRole: membership.role,
        action: "report.prior_year_replaced",
        resourceType: "tax_filing",
        resourceId: replaceTarget.id,
        resourceLabel: `${replaceTarget.tax_year} prior filing`,
        metadata: { filename: file.name },
      });
    } finally {
      setIsReplacing(false);
      setReplaceTarget(null);
    }
  }

  // ── Archive filing ──────────────────────────────────────
  async function handleArchive(filing: TaxFormFiling) {
    const confirmed = window.confirm(
      `Archive the ${filing.tax_year} ${sourceLabel(filing.source)} filing?\n\nIt will be hidden from this list but not permanently deleted.`,
    );
    if (!confirmed) return;

    setArchivingId(filing.id);
    await supabase
      .from("tax_form_filings")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", filing.id);
    setFilings((prev) => prev.filter((f) => f.id !== filing.id));
    setArchivingId(null);
  }

  // ─────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Replace-file input (hidden) ── */}
      <input
        ref={replaceInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        style={{ display: "none" }}
        onChange={handleReplaceFileChange}
      />

      {/* ── View modal ── */}
      {viewFiling && (
        <div className="tf-modal-backdrop" onClick={handleCloseView} role="dialog" aria-modal="true">
          <div className="tf-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tf-modal-hdr">
              <div>
                <p className="eyebrow tf-modal-eyebrow">
                  {sourceLabel(viewFiling.source)}
                </p>
                <h2 className="tf-modal-title">
                  {viewFiling.tax_year} NYS 2% Filing
                </h2>
                <p className="muted tf-modal-meta">
                  Status: <strong>{statusLabel(viewFiling.status)}</strong>
                  &ensp;&middot;&ensp;
                  Last updated: {fmtDate(viewFiling.updated_at)}
                  {viewFiling.file_name && (
                    <>&ensp;&middot;&ensp;{viewFiling.file_name}</>
                  )}
                </p>
              </div>
              <button
                type="button"
                className="tf-modal-close"
                onClick={handleCloseView}
                aria-label="Close"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Preview */}
            <div className="tf-modal-preview">
              {viewLoading && (
                <div className="tf-modal-loading">
                  <TfSpinner /> Loading preview…
                </div>
              )}
              {!viewLoading && !viewFiling.file_path && (
                <div className="tf-modal-no-file">
                  <p className="muted">No file stored for this draft yet.</p>
                  <p className="muted">Download a PDF from the report builder to save it here.</p>
                </div>
              )}
              {!viewLoading && viewFiling.file_path && viewUrl && (
                isImage(viewFiling.file_mime_type) ? (
                  <img
                    src={viewUrl}
                    alt={`${viewFiling.tax_year} NYS 2% filing`}
                    className="tf-modal-img"
                  />
                ) : (
                  <iframe
                    src={viewUrl}
                    className="tf-modal-iframe"
                    title={`${viewFiling.tax_year} NYS 2% filing`}
                  />
                )
              )}
              {!viewLoading && viewFiling.file_path && !viewUrl && (
                <div className="tf-modal-no-file">
                  <p className="muted">Preview not available. Use Download to access the file.</p>
                </div>
              )}
            </div>

            {viewFiling.file_path && (
              <div className="tf-modal-footer">
                <button
                  type="button"
                  className="fb-primary-btn"
                  onClick={() => handleDownload(viewFiling)}
                >
                  Download
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Section card ── */}
      <section className="card tf-section">
        <div className="tf-section-hdr">
          <div>
            <p className="eyebrow">Filing History</p>
            <h2 className="tf-section-title">Previous NYS 2% Filings</h2>
          </div>
        </div>

        {loading ? (
          <div className="tf-loading">
            <TfSpinner /> Loading filings…
          </div>
        ) : filings.length === 0 ? (
          <div className="tf-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="tf-empty-icon" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <p className="tf-empty-msg">No prior NYS 2% filings saved yet.</p>
            <p className="muted tf-empty-sub">
              Upload a prior filing or generate your first report using the builder above.
            </p>
          </div>
        ) : (
          <>
            {/* ── Desktop table ── */}
            <div className="tf-table-wrap">
              <table className="tf-table">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Source</th>
                    <th>Status</th>
                    <th>File</th>
                    <th>Last Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filings.map((f) => (
                    <FilingRow
                      key={f.id}
                      filing={f}
                      archivingId={archivingId}
                      isReplacing={isReplacing && replaceTarget?.id === f.id}
                      onView={() => handleView(f)}
                      onDownload={() => handleDownload(f)}
                      onReplace={() => handleReplaceClick(f)}
                      onArchive={() => handleArchive(f)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Mobile cards ── */}
            <div className="tf-cards">
              {filings.map((f) => (
                <FilingCard
                  key={f.id}
                  filing={f}
                  archivingId={archivingId}
                  isReplacing={isReplacing && replaceTarget?.id === f.id}
                  onView={() => handleView(f)}
                  onDownload={() => handleDownload(f)}
                  onReplace={() => handleReplaceClick(f)}
                  onArchive={() => handleArchive(f)}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}

// ─────────────────────────────────────────────────────────
// Row + Card sub-components
// ─────────────────────────────────────────────────────────

function FilingRow({
  filing,
  archivingId,
  isReplacing,
  onView, onDownload, onReplace, onArchive,
}: {
  filing: TaxFormFiling;
  archivingId: string | null;
  isReplacing: boolean;
  onView: () => void;
  onDownload: () => void;
  onReplace: () => void;
  onArchive: () => void;
}) {
  const isArchiving = archivingId === filing.id;
  const hasFile = !!filing.file_path;

  return (
    <tr className="tf-row">
      <td className="tf-cell-year">{filing.tax_year}</td>
      <td>
        <span className={`tf-source-badge tf-source-badge--${filing.source === "generated_firebook" ? "gen" : "up"}`}>
          {sourceLabel(filing.source)}
        </span>
      </td>
      <td>
        <span className={`tf-status-badge tf-status-badge--${filing.status}`}>
          {statusLabel(filing.status)}
        </span>
      </td>
      <td className="tf-cell-file">
        {filing.file_name ? (
          <span className="tf-filename">{filing.file_name}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="muted">{fmtDate(filing.updated_at)}</td>
      <td>
        <div className="tf-actions">
          <button type="button" className="tf-action-btn" onClick={onView}>
            View
          </button>
          {hasFile && (
            <button type="button" className="tf-action-btn" onClick={onDownload}>
              Download
            </button>
          )}
          {filing.source === "uploaded_prior_filing" && (
            <button type="button" className="tf-action-btn tf-action-btn--warn" onClick={onReplace} disabled={isReplacing}>
              {isReplacing ? "Replacing…" : "Replace"}
            </button>
          )}
          <button type="button" className="tf-action-btn tf-action-btn--muted" onClick={onArchive} disabled={isArchiving}>
            {isArchiving ? "…" : "Archive"}
          </button>
        </div>
      </td>
    </tr>
  );
}

function FilingCard({
  filing,
  archivingId,
  isReplacing,
  onView, onDownload, onReplace, onArchive,
}: {
  filing: TaxFormFiling;
  archivingId: string | null;
  isReplacing: boolean;
  onView: () => void;
  onDownload: () => void;
  onReplace: () => void;
  onArchive: () => void;
}) {
  const isArchiving = archivingId === filing.id;
  const hasFile = !!filing.file_path;

  return (
    <div className="tf-card">
      <div className="tf-card-top">
        <span className="tf-card-year">{filing.tax_year}</span>
        <span className={`tf-status-badge tf-status-badge--${filing.status}`}>
          {statusLabel(filing.status)}
        </span>
      </div>
      <p className="tf-card-source">{sourceLabel(filing.source)}</p>
      {filing.file_name && (
        <p className="tf-card-file muted">{filing.file_name}</p>
      )}
      <p className="tf-card-date muted">Updated {fmtDate(filing.updated_at)}</p>
      <div className="tf-actions tf-card-actions">
        <button type="button" className="tf-action-btn" onClick={onView}>
          View
        </button>
        {hasFile && (
          <button type="button" className="tf-action-btn" onClick={onDownload}>
            Download
          </button>
        )}
        {filing.source === "uploaded_prior_filing" && (
          <button type="button" className="tf-action-btn tf-action-btn--warn" onClick={onReplace} disabled={isReplacing}>
            {isReplacing ? "Replacing…" : "Replace"}
          </button>
        )}
        <button type="button" className="tf-action-btn tf-action-btn--muted" onClick={onArchive} disabled={isArchiving}>
          {isArchiving ? "…" : "Archive"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────

function TfSpinner() {
  return (
    <svg
      className="nys-spinner"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden="true"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
