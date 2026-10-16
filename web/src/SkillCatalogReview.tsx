import { useEffect, useState } from "react";
import type { SkillCatalogReviewItem } from "../../shared/api";

const categories = [
  "Languages", "Frameworks & Libraries", "Databases", "Cloud & DevOps", "Data & Analytics",
  "Architecture & Messaging", "Testing & Monitoring", "Security", "AI & Machine Learning",
  "Tools & Platforms", "Business Analysis & Requirements", "Process & Operations",
  "Business Tools & Platforms", "Project & Delivery Methods", "Industry & Domain Knowledge",
  "Other Professional Skills",
];
const roleAreas = [
  ["software-engineering", "Software engineering"], ["business-analysis", "Business analysis"],
  ["data-analytics", "Data analytics"], ["project-management", "Project management"],
  ["operations", "Operations"], ["finance", "Finance"], ["sales-marketing", "Sales and marketing"],
  ["healthcare", "Healthcare"], ["education", "Education"], ["customer-support", "Customer support"], ["general", "General"],
];

function messageFrom(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : fallback;
}

export default function SkillCatalogReview() {
  const [items, setItems] = useState<SkillCatalogReviewItem[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { aliases: string; category: string; roleArea: string; definition: string }>>({});

  async function refresh(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/skill-catalog/review", { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json() as { canManage?: boolean; items?: SkillCatalogReviewItem[]; error?: string };
      if (!response.ok) throw new Error(messageFrom(payload, "The vocabulary review queue could not be loaded."));
      setCanManage(payload.canManage === true);
      const pending = Array.isArray(payload.items) ? payload.items : [];
      setItems(pending);
      setDrafts(Object.fromEntries(pending.map((item) => [item.canonical, {
        aliases: item.aliases.filter((alias) => alias !== item.canonical).join(", "),
        category: item.category,
        roleArea: item.roleArea,
        definition: item.definition,
      }])));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The vocabulary review queue could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function review(item: SkillCatalogReviewItem, status: "active" | "rejected"): Promise<void> {
    const draft = drafts[item.canonical];
    if (!draft) return;
    setSaving(item.canonical);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/skill-catalog/review/${encodeURIComponent(item.canonical)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aliases: [...new Set([item.canonical, ...draft.aliases.split(",").map((alias) => alias.trim()).filter(Boolean)])],
          category: draft.category,
          roleArea: draft.roleArea,
          definition: draft.definition,
          status,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(messageFrom(payload, "The vocabulary entry could not be saved."));
      setItems((current) => current.filter((candidate) => candidate.canonical !== item.canonical));
      setNotice(`${item.canonical} was ${status === "active" ? "approved for future matching" : "rejected"}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The vocabulary entry could not be saved.");
    } finally {
      setSaving(null);
    }
  }

  if (!canManage && !loading && !error) return null;
  return (
    <details className="catalog-review">
      <summary>Vocabulary review {loading ? "· loading" : `· ${items.length} pending`}</summary>
      <div className="catalog-review-list">
        <p className="hosted-help-copy">This shared catalog helps recognize terms in future job descriptions. Approval adds vocabulary only; it never confirms that a user has that experience.</p>
        {notice && <p className="account-notice" role="status">{notice}</p>}
        {error && <p className="error-message" role="alert">{error} <button className="text-button" type="button" onClick={() => void refresh()}>Retry</button></p>}
        {loading && <p className="hosted-help-copy" role="status">Loading pending vocabulary…</p>}
        {!loading && !items.length && !error && <p className="hosted-empty-state">There are no vocabulary entries waiting for review.</p>}
        {items.map((item) => {
          const draft = drafts[item.canonical];
          if (!draft) return null;
          const update = (key: keyof typeof draft, value: string) => setDrafts((current) => ({ ...current, [item.canonical]: { ...current[item.canonical], [key]: value } }));
          return (
            <article className="catalog-review-item" key={item.canonical}>
              <h3>{item.canonical}</h3>
              <p>{item.reviewReason || `Detected in ${item.sourceCount} successful run${item.sourceCount === 1 ? "" : "s"}.`} Confidence: {item.confidence ?? "review"}.</p>
              <div className="catalog-review-fields">
                <label>Aliases, comma separated<input value={draft.aliases} onChange={(event) => update("aliases", event.target.value)} /></label>
                <label>Category<select value={draft.category} onChange={(event) => update("category", event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
                <label>Role area<select value={draft.roleArea} onChange={(event) => update("roleArea", event.target.value)}>{roleAreas.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="catalog-definition">Meaning<textarea value={draft.definition} maxLength={240} onChange={(event) => update("definition", event.target.value)} /></label>
              </div>
              <div className="catalog-review-actions">
                <button className="primary-button" type="button" disabled={saving !== null} onClick={() => void review(item, "active")}>{saving === item.canonical ? "Saving…" : "Approve"}</button>
                <button className="secondary-button" type="button" disabled={saving !== null} onClick={() => void review(item, "rejected")}>Reject</button>
              </div>
            </article>
          );
        })}
      </div>
    </details>
  );
}
