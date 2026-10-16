import { promises as fs } from "fs";
import * as path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SkillRoleArea =
  | "software-engineering"
  | "business-analysis"
  | "data-analytics"
  | "project-management"
  | "operations"
  | "finance"
  | "sales-marketing"
  | "healthcare"
  | "education"
  | "customer-support"
  | "general";

export type CatalogConfidence = "high" | "medium" | "low";

export interface SkillCatalogEntry {
  canonical: string;
  aliases: string[];
  category: string;
  roleArea: SkillRoleArea;
  definition: string;
}

export interface SkillCatalogCandidate extends SkillCatalogEntry {
  confidence: CatalogConfidence;
}

export interface SkillCatalogReviewItem extends SkillCatalogEntry {
  status: "pending" | "active" | "rejected";
  confidence?: CatalogConfidence;
  reviewReason: string | null;
  sourceCount: number;
}

interface StoredSkillCatalogRow {
  canonical: string;
  normalized_key: string;
  aliases: string[];
  category: string;
  role_area: SkillRoleArea;
  definition: string;
  status: "active" | "pending" | "rejected";
  review_reason: string | null;
  source_count: number;
}

const projectRoot = process.cwd();
const seedPath = path.join(projectRoot, "config", "skill-dictionary.json");
const localCatalogPath = path.join(projectRoot, "Data", "skill-catalog.learned.json");
const allowedCategories = new Set([
  "Languages", "Frameworks & Libraries", "Databases", "Cloud & DevOps", "Data & Analytics",
  "Architecture & Messaging", "Testing & Monitoring", "Security", "AI & Machine Learning",
  "Tools & Platforms", "Business Analysis & Requirements", "Process & Operations",
  "Business Tools & Platforms", "Project & Delivery Methods", "Industry & Domain Knowledge",
  "Other Professional Skills",
]);
const allowedRoleAreas = new Set<SkillRoleArea>([
  "software-engineering", "business-analysis", "data-analytics", "project-management", "operations",
  "finance", "sales-marketing", "healthcare", "education", "customer-support", "general",
]);
const genericTerms = new Set(["skill", "experience", "knowledge", "responsibility", "communication", "teamwork"]);

export function normalizeCatalogTerm(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9+#.]+/g, " ").trim().replace(/\s+/g, " ");
}

function parseEntry(value: unknown): SkillCatalogEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.canonical !== "string" || item.canonical.trim().length < 2 || item.canonical.trim().length > 80 ||
      !Array.isArray(item.aliases) || item.aliases.length > 30 ||
      item.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 100) ||
      typeof item.category !== "string" || !allowedCategories.has(item.category) ||
      typeof item.roleArea !== "string" || !allowedRoleAreas.has(item.roleArea as SkillRoleArea) ||
      typeof item.definition !== "string" || item.definition.length > 240) return null;
  return {
    canonical: item.canonical.trim(),
    aliases: [...new Set([item.canonical.trim(), ...item.aliases.map((alias: string) => alias.trim())])],
    category: item.category,
    roleArea: item.roleArea as SkillRoleArea,
    definition: item.definition.trim(),
  };
}

export function validateSkillCatalogCandidates(value: unknown): SkillCatalogCandidate[] {
  if (!Array.isArray(value) || value.length > 100) return [];
  return value.flatMap((raw) => {
    const entry = parseEntry(raw);
    if (!entry || genericTerms.has(normalizeCatalogTerm(entry.canonical))) return [];
    const confidence = (raw as Record<string, unknown>).confidence;
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return [];
    return [{ ...entry, confidence }];
  });
}

async function readSeedEntries(): Promise<SkillCatalogEntry[]> {
  const seed = JSON.parse(await fs.readFile(seedPath, "utf8")) as unknown;
  if (!Array.isArray(seed)) throw new Error("The built-in skill catalog is invalid.");
  return seed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.canonical !== "string" || !Array.isArray(raw.aliases) || raw.aliases.some((alias) => typeof alias !== "string")) return [];
    const category = typeof raw.category === "string" && allowedCategories.has(raw.category) ? raw.category : "Tools & Platforms";
    return [{
      canonical: raw.canonical,
      aliases: [...new Set([raw.canonical, ...(raw.aliases as string[])])],
      category,
      roleArea: "general" as const,
      definition: "",
    }];
  });
}

async function readLocalLearnedRows(): Promise<Array<SkillCatalogEntry & { status: "active" | "pending" | "rejected"; review_reason: string | null; source_count: number }>> {
  const text = await fs.readFile(localCatalogPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The local learned-skill catalog is invalid JSON. Repair or remove Data/skill-catalog.learned.json, then retry.");
  }
  if (!Array.isArray(parsed)) throw new Error("The local learned-skill catalog must contain a JSON array.");
  return parsed.map((item, index) => {
    const entry = parseEntry(item);
    const row = item as Record<string, unknown>;
    if (!entry || (row.status !== "active" && row.status !== "pending" && row.status !== "rejected") ||
        (row.review_reason !== null && row.review_reason !== undefined && typeof row.review_reason !== "string") ||
        !Number.isInteger(row.source_count) || Number(row.source_count) < 1) {
      throw new Error(`Local learned-skill catalog entry ${index + 1} is invalid. Repair Data/skill-catalog.learned.json, then retry.`);
    }
    return {
      ...entry,
      status: row.status,
      review_reason: typeof row.review_reason === "string" ? row.review_reason : null,
      source_count: Number(row.source_count),
    };
  });
}

function mergeEntries(entries: SkillCatalogEntry[]): SkillCatalogEntry[] {
  const byCanonical = new Map<string, SkillCatalogEntry>();
  for (const entry of entries) {
    const key = normalizeCatalogTerm(entry.canonical);
    if (!key) continue;
    const existing = byCanonical.get(key);
    if (!existing) {
      byCanonical.set(key, { ...entry, aliases: [...new Set([entry.canonical, ...entry.aliases])] });
      continue;
    }
    existing.aliases = [...new Set([...existing.aliases, ...entry.aliases, entry.canonical])];
    if (!existing.definition && entry.definition) existing.definition = entry.definition;
    if (existing.roleArea === "general" && entry.roleArea !== "general") existing.roleArea = entry.roleArea;
    if (existing.category === "Tools & Platforms" && entry.category !== "Tools & Platforms") existing.category = entry.category;
  }
  return [...byCanonical.values()];
}

export async function loadLocalSkillCatalog(): Promise<SkillCatalogEntry[]> {
  const seed = await readSeedEntries();
  const learned = await readLocalLearnedRows();
  const active = learned.filter((row) => row.status === "active");
  return mergeEntries([...seed, ...active]);
}

function rowToEntry(row: StoredSkillCatalogRow): SkillCatalogEntry {
  return { canonical: row.canonical, aliases: row.aliases, category: row.category, roleArea: row.role_area, definition: row.definition };
}

export async function loadHostedSkillCatalog(admin: SupabaseClient): Promise<SkillCatalogEntry[]> {
  const seed = await readSeedEntries();
  const result = await admin.from("skill_catalog")
    .select("canonical, normalized_key, aliases, category, role_area, definition, status, review_reason, source_count")
    .limit(5000);
  if (result.error) throw new Error("Shared skill catalog is unavailable. Apply the latest Supabase migration, then retry.");
  let rows = (result.data ?? []) as StoredSkillCatalogRow[];
  const present = new Set(rows.map((row) => row.normalized_key));
  // PostgreSQL requires normalized_key to be at least two characters. Keep
  // valid one-character technologies (for example, R) in the in-memory seed
  // catalog, but don't try to persist them in the shared table.
  const missingSeed = seed.filter((entry) => {
    const key = normalizeCatalogTerm(entry.canonical);
    return key.length >= 2 && !present.has(key);
  });
  if (missingSeed.length) {
    const seeded = missingSeed.map((entry) => ({
      canonical: entry.canonical,
      normalized_key: normalizeCatalogTerm(entry.canonical),
      aliases: entry.aliases,
      category: entry.category,
      role_area: entry.roleArea,
      definition: entry.definition,
      status: "active" as const,
      review_reason: null,
      source_count: 1,
    }));
    const inserted = await admin.from("skill_catalog").upsert(seeded, { onConflict: "normalized_key", ignoreDuplicates: true });
    if (inserted.error) {
      console.error("Shared skill catalog seed failed:", inserted.error.code ?? "unknown", inserted.error.message);
      throw new Error("Shared skill catalog could not be initialized. Check the server log for the database error, then retry.");
    }
    rows = [...rows, ...missingSeed.map((entry) => ({
      canonical: entry.canonical,
      normalized_key: normalizeCatalogTerm(entry.canonical),
      aliases: entry.aliases,
      category: entry.category,
      role_area: entry.roleArea,
      definition: entry.definition,
      status: "active" as const,
      review_reason: null,
      source_count: 1,
    }))];
  }
  const active = rows.filter((row) => row.status === "active").map(rowToEntry);
  return mergeEntries([...seed, ...active]);
}

function prepareCandidateRows(
  candidates: SkillCatalogCandidate[],
  existing: Array<{
    canonical: string;
    normalized_key: string;
    aliases: string[];
    status: string;
    source_count: number;
    category?: string;
    role_area?: SkillRoleArea;
    definition?: string;
  }>,
  autoActivateNew = true,
): StoredSkillCatalogRow[] {
  const owners = new Map<string, string>();
  for (const row of existing) {
    for (const term of [row.canonical, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
      const normalized = normalizeCatalogTerm(term);
      if (normalized) owners.set(normalized, row.canonical);
    }
  }
  const result = new Map<string, StoredSkillCatalogRow>();
  for (const candidate of candidates) {
    const normalizedKey = normalizeCatalogTerm(candidate.canonical);
    if (!normalizedKey || !allowedCategories.has(candidate.category) || !allowedRoleAreas.has(candidate.roleArea)) continue;
    const conflicts = [...new Set([candidate.canonical, ...candidate.aliases]
      .map(normalizeCatalogTerm)
      .flatMap((term) => {
        const owner = owners.get(term);
        return owner && normalizeCatalogTerm(owner) !== normalizedKey ? [owner] : [];
      }))];
    const existingRow = existing.find((row) => row.normalized_key === normalizedKey);
    const sameRun = result.get(normalizedKey);
    const preserveActive = existingRow?.status === "active";
    const aliases = preserveActive && conflicts.length
      ? [...new Set([existingRow.canonical, ...existingRow.aliases])]
      : [...new Set([candidate.canonical, ...candidate.aliases, ...(existingRow?.aliases ?? []), ...(sameRun?.aliases ?? [])])];
    const reviewReason = existingRow?.status === "rejected" ? (existingRow as StoredSkillCatalogRow).review_reason ?? "Previously rejected during review."
      : existingRow?.status === "pending" ? (existingRow as StoredSkillCatalogRow).review_reason ?? "Awaiting admin review."
      : conflicts.length
      ? `Term aliases overlap existing catalog entries: ${conflicts.join(", ")}.`
      : autoActivateNew && candidate.confidence === "high" && candidate.definition.length >= 8 ? null
      : candidate.confidence === "high" ? autoActivateNew
        ? "AI did not provide enough context for a safe automatic catalog entry."
        : "Awaiting owner review before shared terms can be used for matching."
      : `AI marked this candidate ${candidate.confidence} confidence.`;
    result.set(normalizedKey, {
      canonical: existingRow?.canonical ?? candidate.canonical,
      normalized_key: normalizedKey,
      aliases,
      category: preserveActive ? existingRow.category ?? candidate.category : candidate.category,
      role_area: preserveActive ? existingRow.role_area ?? candidate.roleArea : candidate.roleArea,
      definition: preserveActive ? existingRow.definition || candidate.definition : candidate.definition,
      status: existingRow?.status === "rejected" ? "rejected" : existingRow?.status === "pending" ? "pending" : existingRow?.status === "active" ? "active" : reviewReason ? "pending" : "active",
      review_reason: existingRow?.status === "active" ? null : reviewReason,
      source_count: (existingRow?.source_count ?? 0) + (sameRun ? 0 : 1),
    });
    if (!owners.has(normalizedKey)) owners.set(normalizedKey, existingRow?.canonical ?? candidate.canonical);
    for (const alias of aliases) {
      const aliasKey = normalizeCatalogTerm(alias);
      if (aliasKey && !owners.has(aliasKey)) owners.set(aliasKey, existingRow?.canonical ?? candidate.canonical);
    }
  }
  return [...result.values()];
}

async function readHostedRows(admin: SupabaseClient) {
  const result = await admin.from("skill_catalog")
    .select("canonical, normalized_key, aliases, category, role_area, definition, status, review_reason, source_count")
    .limit(5000);
  if (result.error) throw new Error("Shared skill catalog could not be read.");
  return (result.data ?? []) as StoredSkillCatalogRow[];
}

export async function persistHostedSkillCandidates(
  admin: SupabaseClient,
  candidates: SkillCatalogCandidate[],
): Promise<{ active: number; pending: number }> {
  const valid = validateSkillCatalogCandidates(candidates);
  if (!valid.length) return { active: 0, pending: 0 };
  const existing = await readHostedRows(admin);
  // Shared entries stay pending until the owner approves them. Besides keeping
  // AI-generated aliases out of matching by default, this lets the database
  // enforce alias uniqueness during the approval transaction.
  const rows = prepareCandidateRows(valid, existing, false);
  const upserted = await admin.from("skill_catalog").upsert(rows, { onConflict: "normalized_key" });
  if (upserted.error) throw new Error("New shared skill terms could not be saved.");
  return { active: rows.filter((row) => row.status === "active").length, pending: rows.filter((row) => row.status === "pending").length };
}

export async function persistLocalSkillCandidates(candidates: SkillCatalogCandidate[]): Promise<{ active: number; pending: number }> {
  const valid = validateSkillCatalogCandidates(candidates);
  if (!valid.length) return { active: 0, pending: 0 };
  await fs.mkdir(path.dirname(localCatalogPath), { recursive: true });
  const lockPath = `${localCatalogPath}.lock`;
  await fs.writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try {
    const previous = await readLocalLearnedRows();
    const seed = await readSeedEntries();
    const existing = [...seed.map((entry) => ({ canonical: entry.canonical, normalized_key: normalizeCatalogTerm(entry.canonical), aliases: entry.aliases, status: "active", source_count: 1, category: entry.category, role_area: entry.roleArea, definition: entry.definition })),
      ...previous.map((entry) => ({ canonical: entry.canonical, normalized_key: normalizeCatalogTerm(entry.canonical), aliases: entry.aliases, status: entry.status, source_count: entry.source_count, category: entry.category, role_area: entry.roleArea, definition: entry.definition }))];
    const rows = prepareCandidateRows(valid, existing);
    const allRows = new Map<string, Record<string, unknown>>();
    for (const item of previous) allRows.set(normalizeCatalogTerm(item.canonical), { ...item });
    for (const entry of seed) {
      const key = normalizeCatalogTerm(entry.canonical);
      if (!allRows.has(key)) allRows.set(key, { ...entry, status: "active", source_count: 1, review_reason: null });
    }
    for (const row of rows) allRows.set(row.normalized_key, {
      canonical: row.canonical, aliases: row.aliases, category: row.category, roleArea: row.role_area,
      definition: row.definition, status: row.status, review_reason: row.review_reason,
      source_count: row.source_count,
    });
    const tempPath = `${localCatalogPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify([...allRows.values()], null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, localCatalogPath);
    return { active: rows.filter((row) => row.status === "active").length, pending: rows.filter((row) => row.status === "pending").length };
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function reviewItem(entry: SkillCatalogEntry & { status: "active" | "pending" | "rejected"; review_reason: string | null; source_count: number }): SkillCatalogReviewItem {
  return {
    canonical: entry.canonical,
    aliases: entry.aliases,
    category: entry.category,
    roleArea: entry.roleArea,
    definition: entry.definition,
    status: entry.status,
    reviewReason: entry.review_reason,
    sourceCount: entry.source_count,
  };
}

export async function listLocalSkillCatalogReviewItems(): Promise<SkillCatalogReviewItem[]> {
  return (await readLocalLearnedRows())
    .filter((entry) => entry.status === "pending")
    .map(reviewItem);
}

export async function updateLocalSkillCatalogReviewItem(
  canonical: string,
  update: Pick<SkillCatalogEntry, "aliases" | "category" | "roleArea" | "definition"> & { status: "active" | "rejected" },
): Promise<void> {
  const key = normalizeCatalogTerm(canonical);
  const parsed = parseEntry({ canonical, ...update });
  if (!key || !parsed) throw new Error("The catalog entry is invalid. Check its aliases, category, role area, and definition.");
  await fs.mkdir(path.dirname(localCatalogPath), { recursive: true });
  const lockPath = `${localCatalogPath}.lock`;
  await fs.writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try {
    const rows = await readLocalLearnedRows();
    const index = rows.findIndex((entry) => normalizeCatalogTerm(entry.canonical) === key);
    if (index < 0 || rows[index].status !== "pending") throw new Error("This pending catalog entry has changed. Refresh the list and retry.");
    if (update.status === "active") {
      const seed = await readSeedEntries();
      const activeEntries = [
        ...seed,
        ...rows.filter((entry, rowIndex) => rowIndex !== index && entry.status === "active"),
      ];
      const occupied = new Map<string, string>();
      for (const entry of activeEntries) {
        for (const term of [entry.canonical, ...entry.aliases]) {
          const normalized = normalizeCatalogTerm(term);
          if (normalized) occupied.set(normalized, entry.canonical);
        }
      }
      const conflict = [...new Set([parsed.canonical, ...parsed.aliases]
        .map(normalizeCatalogTerm)
        .flatMap((term) => {
          const owner = occupied.get(term);
          return owner && normalizeCatalogTerm(owner) !== key ? [owner] : [];
        }))];
      if (conflict.length) throw new Error(`These aliases already belong to active catalog entries: ${conflict.join(", ")}. Edit the aliases and retry.`);
    }
    rows[index] = {
      ...rows[index],
      ...parsed,
      status: update.status,
      review_reason: update.status === "rejected" ? "Rejected by catalog owner." : null,
    };
    const tempPath = `${localCatalogPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, localCatalogPath);
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function listHostedSkillCatalogReviewItems(admin: SupabaseClient): Promise<SkillCatalogReviewItem[]> {
  return (await readHostedRows(admin))
    .filter((row) => row.status === "pending")
    .map((row) => ({ ...rowToEntry(row), status: row.status, reviewReason: row.review_reason, sourceCount: row.source_count }));
}

export async function updateHostedSkillCatalogReviewItem(
  admin: SupabaseClient,
  canonical: string,
  update: Pick<SkillCatalogEntry, "aliases" | "category" | "roleArea" | "definition"> & { status: "active" | "rejected" },
): Promise<void> {
  const normalizedKey = normalizeCatalogTerm(canonical);
  const parsed = parseEntry({ canonical, ...update });
  if (!normalizedKey || !parsed) throw new Error("The catalog entry is invalid. Check its aliases, category, role area, and definition.");
  const aliasKeys = [...new Set([parsed.canonical, ...parsed.aliases].map(normalizeCatalogTerm).filter(Boolean))];
  const result = await admin.rpc("review_skill_catalog_entry", {
    p_normalized_key: normalizedKey,
    p_canonical: parsed.canonical,
    p_aliases: parsed.aliases,
    p_alias_keys: aliasKeys,
    p_category: parsed.category,
    p_role_area: parsed.roleArea,
    p_definition: parsed.definition,
    p_status: update.status,
  });
  if (result.error) {
    if (result.error.message.includes("catalog_alias_conflict")) {
      throw new Error("One or more aliases already belong to an active catalog entry. Edit the aliases and retry.");
    }
    if (result.error.message.includes("pending_entry_changed")) {
      throw new Error("This pending catalog entry has changed. Refresh the list and retry.");
    }
    throw new Error("The shared catalog entry could not be updated.");
  }
}
