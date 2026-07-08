"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AUDIT_ACTION_LABELS,
  type AuditLogRecord,
  formatAuditAction,
} from "../lib/audit";
import { supabase } from "../lib/supabase";
import type { DepartmentMembership } from "../lib/types";

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function prettyJson(value: unknown): string {
  if (value == null) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resourceLabel(log: AuditLogRecord): string {
  return log.resource_label || log.resource_id || log.resource_type;
}

function detailsSummary(log: AuditLogRecord): string {
  if (log.metadata && Object.keys(log.metadata).length > 0) {
    const parts = Object.entries(log.metadata)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    return parts.join(" · ");
  }
  if (log.before_data && log.after_data) {
    return "Changed fields recorded";
  }
  if (log.after_data) {
    return "New values recorded";
  }
  return "—";
}

function csvEscape(value: unknown): string {
  const str = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportAuditCsv(logs: AuditLogRecord[]) {
  const headers = [
    "created_at",
    "user_email",
    "user_role",
    "action",
    "resource_type",
    "resource_label",
    "resource_id",
    "before_data",
    "after_data",
    "metadata",
  ];
  const lines = [
    headers.join(","),
    ...logs.map((log) =>
      [
        log.created_at,
        log.user_email,
        log.user_role,
        log.action,
        log.resource_type,
        log.resource_label,
        log.resource_id,
        log.before_data,
        log.after_data,
        log.metadata,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function AuditDetailDrawer({ log, onClose }: { log: AuditLogRecord; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fb-audit-drawer-root" role="presentation" onClick={onClose}>
      <div
        className="fb-audit-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-audit-drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fb-audit-drawer-head">
          <div>
            <p className="eyebrow">Audit entry</p>
            <h2 id="fb-audit-drawer-title">{formatAuditAction(log.action)}</h2>
          </div>
          <button type="button" className="fb-secondary-btn" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="fb-audit-drawer-body">
          <dl className="fb-audit-facts">
            <div>
              <dt>Timestamp</dt>
              <dd>{fmtDateTime(log.created_at)}</dd>
            </div>
            <div>
              <dt>User</dt>
              <dd>
                {log.user_email || "System"}
                {log.user_role ? <span className="fb-audit-role-badge">{log.user_role}</span> : null}
              </dd>
            </div>
            <div>
              <dt>Action</dt>
              <dd>
                <span className="fb-audit-action-badge">{formatAuditAction(log.action)}</span>
              </dd>
            </div>
            <div>
              <dt>Resource</dt>
              <dd>
                {log.resource_type}
                {log.resource_id ? ` · ${log.resource_id}` : ""}
              </dd>
            </div>
            {log.resource_label ? (
              <div>
                <dt>Label</dt>
                <dd>{log.resource_label}</dd>
              </div>
            ) : null}
            {log.ip_address ? (
              <div>
                <dt>IP address</dt>
                <dd>{log.ip_address}</dd>
              </div>
            ) : null}
            {log.user_agent ? (
              <div>
                <dt>User agent</dt>
                <dd className="fb-audit-user-agent">{log.user_agent}</dd>
              </div>
            ) : null}
          </dl>

          <div className="fb-audit-json-block">
            <h3>Before data</h3>
            <pre>{prettyJson(log.before_data)}</pre>
          </div>
          <div className="fb-audit-json-block">
            <h3>After data</h3>
            <pre>{prettyJson(log.after_data)}</pre>
          </div>
          <div className="fb-audit-json-block">
            <h3>Metadata</h3>
            <pre>{prettyJson(log.metadata)}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AuditTrailSection({
  membership,
  auditTrailEnabled,
  onOpenSettings,
}: {
  membership: DepartmentMembership;
  auditTrailEnabled: boolean;
  onOpenSettings?: () => void;
}) {
  const departmentId = membership.department_id;
  const [logs, setLogs] = useState<AuditLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<AuditLogRecord | null>(null);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [resourceTypeFilter, setResourceTypeFilter] = useState("");
  const [search, setSearch] = useState("");

  const loadLogs = useCallback(async () => {
    if (!auditTrailEnabled) {
      setLogs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setLogs([]);
        return;
      }
      const params = new URLSearchParams({ departmentId });
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);
      if (userFilter) params.set("userId", userFilter);
      if (actionFilter) params.set("action", actionFilter);
      if (resourceTypeFilter) params.set("resourceType", resourceTypeFilter);
      if (search.trim()) params.set("search", search.trim());

      const response = await fetch(`/api/audit-logs?${params.toString()}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) {
        setLogs([]);
        return;
      }
      const payload = (await response.json()) as { logs?: AuditLogRecord[]; auditTrailEnabled?: boolean };
      setLogs(payload.auditTrailEnabled === false ? [] : payload.logs || []);
    } finally {
      setLoading(false);
    }
  }, [actionFilter, auditTrailEnabled, dateFrom, dateTo, departmentId, resourceTypeFilter, search, userFilter]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const userOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const log of logs) {
      if (log.user_id) {
        map.set(log.user_id, log.user_email || log.user_id.slice(0, 8));
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [logs]);

  const actionOptions = useMemo(() => {
    const set = new Set(logs.map((l) => l.action));
    return Array.from(set).sort();
  }, [logs]);

  const resourceTypeOptions = useMemo(() => {
    const set = new Set(logs.map((l) => l.resource_type));
    return Array.from(set).sort();
  }, [logs]);

  return (
    <>
      <section className="card fb-audit-trail">
        <div className="fb-audit-trail-head">
          <div>
            <h1 className="fb-audit-trail-title">Audit Trail</h1>
            <p className="fb-audit-trail-subtitle">
              Review user activity, changes, uploads, reconciliations, and report actions.
            </p>
          </div>
          {auditTrailEnabled ? (
            <button
              type="button"
              className="fb-primary-btn"
              onClick={() => exportAuditCsv(logs)}
              disabled={!logs.length}
            >
              Export CSV
            </button>
          ) : null}
        </div>

        {!auditTrailEnabled ? (
          <div className="fb-audit-disabled-state">
            <p className="fb-audit-disabled-title">Audit Trail is turned off.</p>
            <p className="muted">
              Turn it on in Settings to begin recording important activity.
              {onOpenSettings ? (
                <>
                  {" "}
                  <button type="button" className="fb-audit-settings-link" onClick={onOpenSettings}>
                    Open Security settings
                  </button>
                </>
              ) : null}
            </p>
          </div>
        ) : (
          <>
        <p className="fb-audit-compliance-note muted">
          Audit trail entries are system records and cannot be edited or deleted by regular users.
        </p>

        <div className="fb-audit-filters">
          <label>
            From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <label>
            User
            <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
              <option value="">All users</option>
              {userOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Action
            <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
              <option value="">All actions</option>
              {actionOptions.map((action) => (
                <option key={action} value={action}>
                  {formatAuditAction(action)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Resource type
            <select value={resourceTypeFilter} onChange={(e) => setResourceTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {resourceTypeOptions.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="fb-audit-search-field">
            Search
            <input
              type="search"
              placeholder="Search details…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>

        {loading ? (
          <p className="muted fb-audit-loading">Loading audit trail…</p>
        ) : logs.length === 0 ? (
          <p className="empty-state">No audit entries match your filters.</p>
        ) : (
          <>
            <div className="fb-audit-table-wrap">
              <table className="fb-audit-table">
                <thead>
                  <tr>
                    <th>Date/Time</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Resource</th>
                    <th>Details</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td data-label="Date/Time">{fmtDateTime(log.created_at)}</td>
                      <td data-label="User">{log.user_email || "System"}</td>
                      <td data-label="Action">
                        <span className="fb-audit-action-badge">{formatAuditAction(log.action)}</span>
                      </td>
                      <td data-label="Resource">{resourceLabel(log)}</td>
                      <td data-label="Details" className="fb-audit-details-cell">
                        {detailsSummary(log)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="fb-secondary-btn fb-audit-view-btn"
                          onClick={() => setSelectedLog(log)}
                        >
                          View details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="fb-audit-cards">
              {logs.map((log) => (
                <article key={log.id} className="fb-audit-card">
                  <div className="fb-audit-card-head">
                    <span className="fb-audit-action-badge">{formatAuditAction(log.action)}</span>
                    <time>{fmtDateTime(log.created_at)}</time>
                  </div>
                  <p>
                    <strong>{log.user_email || "System"}</strong>
                  </p>
                  <p className="muted">{resourceLabel(log)}</p>
                  <p className="fb-audit-card-details">{detailsSummary(log)}</p>
                  <button
                    type="button"
                    className="fb-secondary-btn"
                    onClick={() => setSelectedLog(log)}
                  >
                    View details
                  </button>
                </article>
              ))}
            </div>
          </>
        )}
          </>
        )}
      </section>

      {selectedLog ? <AuditDetailDrawer log={selectedLog} onClose={() => setSelectedLog(null)} /> : null}
    </>
  );
}

// Re-export for filter dropdown seeding elsewhere if needed
export { AUDIT_ACTION_LABELS };
