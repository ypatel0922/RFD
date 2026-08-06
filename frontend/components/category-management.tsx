"use client";

import { FormEvent, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  computeCategoryUsageStats,
  DEFAULT_TYPE_LABELS,
  formatCategoryLastUsed,
  getActiveTwoPctCategories,
  getBankEntriesNotActive,
  getCategoryDisplayStatus,
  getUsageForCategory,
  GUIDANCE_BADGE_CLASS,
  GUIDANCE_LABELS,
  normalizeCategoryName,
} from "../lib/categories";
import type { CategorySeed } from "../lib/category-seed";
import type {
  CategoryDefaultType,
  CategoryGroup,
  DepartmentCategory,
  DepartmentVendor,
  ExpenseRecord,
  TwoPercentGuidance,
} from "../lib/types";
import { logAuditFromBrowser } from "../lib/audit";

type CategoryFormState = {
  name: string;
  description: string;
  default_type: CategoryDefaultType;
  two_percent_guidance: TwoPercentGuidance;
  is_active: boolean;
  vendorMappings: string;
};

const EMPTY_FORM: CategoryFormState = {
  name: "",
  description: "",
  default_type: "expense",
  two_percent_guidance: "not_two_percent",
  is_active: true,
  vendorMappings: "",
};

function StatusBadge({ status }: { status: "active" | "hidden" | "custom" }) {
  const tone =
    status === "active" ? "success" : status === "hidden" ? "neutral" : "primary";
  const label = status === "active" ? "Active" : status === "hidden" ? "Hidden" : "Custom";
  return <span className={`fb-settings-pill fb-settings-pill--${tone}`}>{label}</span>;
}

function GuidanceBadge({ guidance }: { guidance: TwoPercentGuidance }) {
  if (guidance === "not_two_percent") {
    return <span className="fb-cat-badge fb-cat-badge--neutral">Not 2%</span>;
  }
  return (
    <span className={`fb-cat-badge ${GUIDANCE_BADGE_CLASS[guidance] || ""}`}>
      {GUIDANCE_LABELS[guidance]}
    </span>
  );
}

function CategoryFormPanel({
  title,
  initial,
  categoryGroup,
  editing,
  saving,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: CategoryFormState;
  categoryGroup: CategoryGroup;
  editing: boolean;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (values: CategoryFormState) => Promise<void>;
}) {
  const [form, setForm] = useState<CategoryFormState>(initial);
  const isTwoPct = categoryGroup === "two_percent";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await onSubmit(form);
  }

  return (
    <section className="card fb-settings-panel-card fb-cat-form-panel">
      <div className="fb-settings-panel-head">
        <div>
          <h3 className="fb-settings-panel-title">{title}</h3>
          <p className="fb-settings-panel-subtitle">
            {isTwoPct
              ? "NYS 2% fund category with guidance classification."
              : "General department expense or income category."}
          </p>
        </div>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <form className="fb-cat-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Category name
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            placeholder={isTwoPct ? "Meeting Food" : "Office Supplies"}
          />
        </label>
        <label>
          Description
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional short description"
          />
        </label>
        <div className="fb-cat-form-row">
          <label>
            Default type
            <select
              value={form.default_type}
              onChange={(e) =>
                setForm({ ...form, default_type: e.target.value as CategoryDefaultType })
              }
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
              <option value="both">Both</option>
            </select>
          </label>
          {isTwoPct ? (
            <label>
              2% Guidance
              <select
                value={form.two_percent_guidance}
                onChange={(e) =>
                  setForm({
                    ...form,
                    two_percent_guidance: e.target.value as TwoPercentGuidance,
                  })
                }
              >
                <option value="likely_eligible">Likely Eligible</option>
                <option value="needs_review">Needs Review</option>
              </select>
            </label>
          ) : (
            <label>
              2% Guidance
              <select
                value={form.two_percent_guidance}
                onChange={(e) =>
                  setForm({
                    ...form,
                    two_percent_guidance: e.target.value as TwoPercentGuidance,
                  })
                }
              >
                <option value="not_two_percent">Not 2%</option>
                <option value="likely_eligible">Likely Eligible</option>
                <option value="needs_review">Needs Review</option>
                <option value="potentially_not_allowed">Potentially Not Allowed</option>
              </select>
            </label>
          )}
        </div>
        <label>
          Default vendor mappings
          <input
            value={form.vendorMappings}
            onChange={(e) => setForm({ ...form, vendorMappings: e.target.value })}
            placeholder="Comma-separated vendor names (optional)"
          />
          <span className="fb-settings-helper-text">
            When these vendors are used, Hallix will suggest this category.
          </span>
        </label>
        <label className="fb-settings-checkbox">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>Show in category dropdowns</span>
        </label>
        <div className="fb-cat-form-actions">
          <button type="submit" className="fb-primary-btn" disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add category"}
          </button>
          <button type="button" className="fb-secondary-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function CategoryTableRow({
  category,
  usage,
  onEdit,
  onHide,
  onRestore,
  onDelete,
  working,
}: {
  category: DepartmentCategory;
  usage: { count: number; lastUsed: string | null };
  onEdit: () => void;
  onHide: () => void;
  onRestore: () => void;
  onDelete: () => void;
  working: boolean;
}) {
  const displayStatus = getCategoryDisplayStatus(category);
  const canDelete = usage.count === 0 && !category.is_system_default;

  return (
  <>
    <tr className={!category.is_active ? "fb-cat-row--hidden" : undefined}>
      <td>
        <strong>{category.name}</strong>
        {category.description ? (
          <p className="fb-cat-desc">{category.description}</p>
        ) : null}
      </td>
      {category.category_group === "two_percent" ? (
        <td>
          <GuidanceBadge guidance={category.two_percent_guidance} />
        </td>
      ) : null}
      <td>{usage.count}</td>
      <td>{formatCategoryLastUsed(usage.lastUsed)}</td>
      {category.category_group === "general" ? (
        <td>{DEFAULT_TYPE_LABELS[category.default_type] || category.default_type}</td>
      ) : null}
      <td>
        <StatusBadge status={displayStatus} />
      </td>
      <td>
        <div className="fb-settings-row-actions">
          <button type="button" className="link-button" disabled={working} onClick={onEdit}>
            Edit
          </button>
          {category.is_active ? (
            <button type="button" className="link-button" disabled={working} onClick={onHide}>
              Hide
            </button>
          ) : (
            <button type="button" className="link-button" disabled={working} onClick={onRestore}>
              Restore
            </button>
          )}
          {canDelete ? (
            <button type="button" className="link-button fb-cat-delete" disabled={working} onClick={onDelete}>
              Delete
            </button>
          ) : null}
        </div>
      </td>
    </tr>
    <tr className="fb-cat-mobile-card" aria-hidden="true">
      <td colSpan={6}>
        <article className={`fb-cat-card ${!category.is_active ? "fb-cat-card--hidden" : ""}`}>
          <div className="fb-cat-card-head">
            <div>
              <h4>{category.name}</h4>
              {category.description ? <p className="fb-cat-desc">{category.description}</p> : null}
            </div>
            <StatusBadge status={displayStatus} />
          </div>
          <dl className="fb-cat-card-meta">
            {category.category_group === "two_percent" ? (
              <div>
                <dt>2% Guidance</dt>
                <dd><GuidanceBadge guidance={category.two_percent_guidance} /></dd>
              </div>
            ) : null}
            <div>
              <dt>Used</dt>
              <dd>{usage.count}</dd>
            </div>
            <div>
              <dt>Last used</dt>
              <dd>{formatCategoryLastUsed(usage.lastUsed)}</dd>
            </div>
            {category.category_group === "general" ? (
              <div>
                <dt>Default type</dt>
                <dd>{DEFAULT_TYPE_LABELS[category.default_type]}</dd>
              </div>
            ) : null}
          </dl>
          <div className="fb-settings-row-actions">
            <button type="button" className="fb-secondary-btn" disabled={working} onClick={onEdit}>
              Edit
            </button>
            {category.is_active ? (
              <button type="button" className="fb-secondary-btn" disabled={working} onClick={onHide}>
                Hide
              </button>
            ) : (
              <button type="button" className="fb-secondary-btn" disabled={working} onClick={onRestore}>
                Restore
              </button>
            )}
            {canDelete ? (
              <button type="button" className="link-button fb-cat-delete" disabled={working} onClick={onDelete}>
                Delete
              </button>
            ) : null}
          </div>
        </article>
      </td>
    </tr>
  </>
  );
}

export function CategoryManagementSection({
  departmentId,
  userRole = "",
  departmentCategories,
  departmentVendors,
  expenses,
  onCategoriesChanged,
  showErrorMessage,
  showSuccessMessage,
}: {
  departmentId: string;
  userRole?: string;
  departmentCategories: DepartmentCategory[];
  departmentVendors: DepartmentVendor[];
  expenses: ExpenseRecord[];
  onCategoriesChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
}) {
  const [formMode, setFormMode] = useState<"none" | "add_two_percent" | "add_general" | "edit">("none");
  const [editingCategory, setEditingCategory] = useState<DepartmentCategory | null>(null);
  const [formInitial, setFormInitial] = useState<CategoryFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [bankPick, setBankPick] = useState("");

  const usageStats = useMemo(() => computeCategoryUsageStats(expenses), [expenses]);

  const activeTwoPctCategories = useMemo(
    () => getActiveTwoPctCategories(departmentCategories, usageStats),
    [departmentCategories, usageStats],
  );

  const bankEntries = useMemo(
    () => getBankEntriesNotActive(departmentCategories),
    [departmentCategories],
  );

  const generalCategories = useMemo(
    () =>
      [...departmentCategories]
        .filter((c) => c.category_group === "general")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [departmentCategories],
  );

  const activeCount = departmentCategories.filter((c) => c.is_active).length;
  const twoPctCount = activeTwoPctCategories.filter((c) => c.is_active).length;
  const generalCount = generalCategories.filter((c) => c.is_active).length;

  const mostUsed = useMemo(() => {
    let top: { name: string; count: number } | null = null;
    for (const cat of departmentCategories) {
      const usage = getUsageForCategory(cat, usageStats);
      if (!top || usage.count > top.count) {
        top = { name: cat.name, count: usage.count };
      }
    }
    if (!top || top.count === 0) {
      for (const [key, stats] of usageStats) {
        if (!top || stats.count > top.count) {
          const match = departmentCategories.find((c) => c.normalized_name === key);
          top = { name: match?.name || key, count: stats.count };
        }
      }
    }
    return top && top.count > 0 ? top.name : "—";
  }, [departmentCategories, usageStats]);

  function openAddForm(group: CategoryGroup) {
    setEditingCategory(null);
    setFormInitial({
      ...EMPTY_FORM,
      two_percent_guidance: group === "two_percent" ? "likely_eligible" : "not_two_percent",
    });
    setFormMode(group === "two_percent" ? "add_two_percent" : "add_general");
  }

  function openEditForm(category: DepartmentCategory) {
    const vendors = departmentVendors
      .filter((v) => v.default_category === category.name)
      .map((v) => v.name)
      .join(", ");
    setEditingCategory(category);
    setFormInitial({
      name: category.name,
      description: category.description || "",
      default_type: category.default_type,
      two_percent_guidance: category.two_percent_guidance,
      is_active: category.is_active,
      vendorMappings: vendors,
    });
    setFormMode("edit");
  }

  function closeForm() {
    setFormMode("none");
    setEditingCategory(null);
    setFormInitial(EMPTY_FORM);
  }

  async function applyVendorMappings(categoryName: string, vendorMappings: string) {
    const names = vendorMappings
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!names.length) return;

    for (const vendorName of names) {
      const normalized = normalizeCategoryName(vendorName);
      const existing = departmentVendors.find((v) => v.normalized_name === normalized);
      if (existing) {
        await supabase
          .from("department_vendors")
          .update({ default_category: categoryName, updated_at: new Date().toISOString() })
          .eq("id", existing.id);
      } else {
        await supabase.from("department_vendors").insert({
          department_id: departmentId,
          name: vendorName,
          normalized_name: normalized,
          default_category: categoryName,
          created_from: "category_mapping",
        });
      }
    }
  }

  async function saveCategory(values: CategoryFormState) {
    const name = values.name.trim();
    if (!name) {
      showErrorMessage("Category name is required.");
      return;
    }
    const normalized = normalizeCategoryName(name);
    const group: CategoryGroup =
      formMode === "add_general" || editingCategory?.category_group === "general"
        ? "general"
        : "two_percent";

    const duplicate = departmentCategories.find(
      (c) => c.normalized_name === normalized && c.id !== editingCategory?.id,
    );
    if (duplicate) {
      showErrorMessage("A category with this name already exists.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name,
        normalized_name: normalized,
        description: values.description.trim() || null,
        category_group: group,
        default_type: values.default_type,
        two_percent_guidance: values.two_percent_guidance,
        is_active: values.is_active,
        updated_at: new Date().toISOString(),
      };

      if (editingCategory) {
        const { error } = await supabase
          .from("department_categories")
          .update(payload)
          .eq("id", editingCategory.id);
        if (error) throw error;
        showSuccessMessage(`Updated "${name}".`);
        void logAuditFromBrowser({
          departmentId,
          userRole,
          action: "category.edited",
          resourceType: "category",
          resourceId: editingCategory.id,
          resourceLabel: name,
          beforeData: {
            name: editingCategory.name,
            description: editingCategory.description,
            is_active: editingCategory.is_active,
          },
          afterData: payload,
        });
      } else {
        const { data: inserted, error } = await supabase.from("department_categories").insert({
          department_id: departmentId,
          ...payload,
          is_system_default: false,
          created_from: "manual",
        }).select("id").single();
        if (error) throw error;
        showSuccessMessage(`Added "${name}".`);
        void logAuditFromBrowser({
          departmentId,
          userRole,
          action: "category.created",
          resourceType: "category",
          resourceId: inserted?.id,
          resourceLabel: name,
          afterData: payload,
        });
      }

      await applyVendorMappings(name, values.vendorMappings);
      await onCategoriesChanged();
      closeForm();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not save category.");
    } finally {
      setSaving(false);
    }
  }

  async function addFromBank(seed: CategorySeed) {
    setWorkingId(seed.key);
    try {
      const normalized = normalizeCategoryName(seed.name);
      const existing = departmentCategories.find((c) => c.normalized_name === normalized);
      if (existing) {
        const { error } = await supabase
          .from("department_categories")
          .update({
            is_active: true,
            created_from: "bank",
            name: seed.name,
            description: seed.description,
            two_percent_guidance: seed.two_percent_guidance,
            default_type: seed.default_type,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("department_categories").insert({
          department_id: departmentId,
          name: seed.name,
          normalized_name: normalized,
          description: seed.description,
          category_group: "two_percent",
          default_type: seed.default_type,
          two_percent_guidance: seed.two_percent_guidance,
          is_system_default: true,
          is_active: true,
          created_from: "bank",
        });
        if (error) throw error;
      }
      showSuccessMessage(`Added "${seed.name}" to your 2% categories.`);
      setBankPick("");
      await onCategoriesChanged();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not add category.");
    } finally {
      setWorkingId(null);
    }
  }

  async function toggleActive(category: DepartmentCategory, active: boolean) {
    setWorkingId(category.id);
    try {
      const { error } = await supabase
        .from("department_categories")
        .update({ is_active: active, updated_at: new Date().toISOString() })
        .eq("id", category.id);
      if (error) throw error;
      showSuccessMessage(active ? `Restored "${category.name}".` : `Hidden "${category.name}".`);
      void logAuditFromBrowser({
        departmentId,
        userRole,
        action: active ? "category.restored" : "category.hidden",
        resourceType: "category",
        resourceId: category.id,
        resourceLabel: category.name,
        beforeData: { is_active: category.is_active },
        afterData: { is_active: active },
      });
      await onCategoriesChanged();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not update category.");
    } finally {
      setWorkingId(null);
    }
  }

  async function deleteCategory(category: DepartmentCategory) {
    const usage = getUsageForCategory(category, usageStats);
    if (usage.count > 0) {
      showErrorMessage("Cannot delete a category that is used by transactions. Hide it instead.");
      return;
    }
    if (category.is_system_default) {
      showErrorMessage("System default categories cannot be deleted. Hide them if not needed.");
      return;
    }
    if (!window.confirm(`Delete "${category.name}"? This cannot be undone.`)) return;

    setWorkingId(category.id);
    try {
      const { error } = await supabase.from("department_categories").delete().eq("id", category.id);
      if (error) throw error;
      showSuccessMessage(`Deleted "${category.name}".`);
      void logAuditFromBrowser({
        departmentId,
        userRole,
        action: "category.deleted",
        resourceType: "category",
        resourceId: category.id,
        resourceLabel: category.name,
      });
      await onCategoriesChanged();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not delete category.");
    } finally {
      setWorkingId(null);
    }
  }

  const editingGroup: CategoryGroup =
    editingCategory?.category_group ||
    (formMode === "add_general" ? "general" : "two_percent");

  return (
    <div className="fb-cat-management">
      <div className="fb-cat-intro">
        <h2 className="fb-settings-panel-title">Categories</h2>
        <p className="fb-settings-panel-subtitle">
          Manage the categories Hallix uses to classify expenses, receipts, vendors, and 2% fund
          activity.
        </p>
      </div>

      <div className="fb-settings-summary-grid fb-cat-summary">
        <div className="fb-settings-summary-card">
          <p className="fb-settings-summary-label">Total Categories</p>
          <p className="fb-settings-summary-value">{activeCount}</p>
        </div>
        <div className="fb-settings-summary-card">
          <p className="fb-settings-summary-label">2% Categories</p>
          <p className="fb-settings-summary-value">{twoPctCount}</p>
        </div>
        <div className="fb-settings-summary-card">
          <p className="fb-settings-summary-label">General Categories</p>
          <p className="fb-settings-summary-value">{generalCount}</p>
        </div>
        <div className="fb-settings-summary-card">
          <p className="fb-settings-summary-label">Most Used Category</p>
          <p className="fb-settings-summary-value fb-cat-most-used">{mostUsed}</p>
        </div>
      </div>

      {formMode !== "none" ? (
        <CategoryFormPanel
          title={
            formMode === "edit"
              ? `Edit ${editingCategory?.name}`
              : formMode === "add_two_percent"
                ? "Add 2% Category"
                : "Add General Category"
          }
          initial={formInitial}
          categoryGroup={editingGroup}
          editing={formMode === "edit"}
          saving={saving}
          onCancel={closeForm}
          onSubmit={saveCategory}
        />
      ) : null}

      <section className="card fb-settings-panel-card">
        <div className="fb-settings-panel-head">
          <div>
            <h2 className="fb-settings-panel-title">Your 2% Categories</h2>
            <p className="fb-settings-panel-subtitle">
              Categories in your dropdowns for 2% fund transactions. Add more from the bank below as
              needed — only starters show by default.
            </p>
          </div>
        </div>
        <div className="table-wrap fb-cat-table-wrap">
          <table className="fb-settings-table fb-cat-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>2% Guidance</th>
                <th>Used</th>
                <th>Last Used</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeTwoPctCategories.length ? (
                activeTwoPctCategories.map((category) => (
                  <CategoryTableRow
                    key={category.id}
                    category={category}
                    usage={getUsageForCategory(category, usageStats)}
                    onEdit={() => openEditForm(category)}
                    onHide={() => void toggleActive(category, false)}
                    onRestore={() => void toggleActive(category, true)}
                    onDelete={() => void deleteCategory(category)}
                    working={workingId === category.id}
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="muted">
                    No 2% categories enabled yet. Add from the category bank below.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {bankEntries.length > 0 ? (
        <details className="card fb-settings-panel-card fb-cat-bank-details">
          <summary className="fb-cat-bank-summary">
            <span className="fb-settings-panel-title">Add from 2% category bank</span>
            <span className="muted">{bankEntries.length} available</span>
          </summary>
          <div className="fb-cat-bank-compact">
            <label className="fb-cat-bank-pick">
              <span className="sr-only">Choose a 2% category</span>
              <select
                value={bankPick}
                onChange={(e) => setBankPick(e.target.value)}
              >
                <option value="">Choose a category to add…</option>
                {bankEntries.map((seed) => (
                  <option key={seed.key} value={seed.key} title={seed.description}>
                    {seed.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="fb-primary-btn"
              disabled={!bankPick || workingId === bankPick}
              onClick={() => {
                const seed = bankEntries.find((s) => s.key === bankPick);
                if (seed) void addFromBank(seed);
              }}
            >
              {workingId === bankPick ? "Adding…" : "Add"}
            </button>
            {bankPick ? (
              <p className="fb-cat-bank-hint muted">
                {bankEntries.find((s) => s.key === bankPick)?.description}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      <section className="card fb-settings-panel-card">
        <div className="fb-settings-panel-head">
          <div>
            <h2 className="fb-settings-panel-title">General Categories</h2>
            <p className="fb-settings-panel-subtitle">
              Categories used for non-2% transactions and regular department expenses.
            </p>
          </div>
          <button
            type="button"
            className="fb-primary-btn"
            onClick={() => openAddForm("general")}
          >
            Add General Category
          </button>
        </div>
        <div className="table-wrap fb-cat-table-wrap">
          <table className="fb-settings-table fb-cat-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Used</th>
                <th>Last Used</th>
                <th>Default Type</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {generalCategories.length ? (
                generalCategories.map((category) => (
                  <CategoryTableRow
                    key={category.id}
                    category={category}
                    usage={getUsageForCategory(category, usageStats)}
                    onEdit={() => openEditForm(category)}
                    onHide={() => void toggleActive(category, false)}
                    onRestore={() => void toggleActive(category, true)}
                    onDelete={() => void deleteCategory(category)}
                    working={workingId === category.id}
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="muted">
                    No general categories yet. They will be seeded automatically on first load.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
