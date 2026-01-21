import * as fs from "fs";
import * as path from "path";

/**
 * Project folder paths (handles data/ vs Data/)
 */
const PROJECT_ROOT = process.cwd();
const DATA_DIR_NAME = fs.existsSync(path.join(PROJECT_ROOT, "data"))
  ? "data"
  : fs.existsSync(path.join(PROJECT_ROOT, "Data"))
  ? "Data"
  : "data";

const INPUT_RESUME_MD = path.join(
  PROJECT_ROOT,
  DATA_DIR_NAME,
  "input",
  "resume",
  "resume_base.md"
);

const OUT_DIR = path.join(PROJECT_ROOT, DATA_DIR_NAME, "out");
const OUTPUT_NORMALIZED_MD = path.join(OUT_DIR, "resume_normalized.md");

function ensureDirs() {
  fs.mkdirSync(path.dirname(INPUT_RESUME_MD), { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function stripBOM(s: string): string {
  return s.replace(/^\uFEFF/, "");
}

/**
 * ---------- Step 1: Basic normalization (bullets/spacing/colons) ----------
 */
function normalizePlainText(md: string): string {
  md = stripBOM(md).replace(/\r\n/g, "\n");

  // Replace common bullets with "-" (keep tabs/spaces safe)
  md = md.replace(/^[ \t]*[•·]\s+/gm, "- ");

  // Collapse excessive blank lines
  md = md.replace(/\n{3,}/g, "\n\n");

  // Normalize "TECHNICAL KNOWLEDGE :" -> "TECHNICAL KNOWLEDGE:"
  md = md.replace(/\s+:\s*/g, ": ");

  // Trim trailing whitespace
  md = md
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n");

  return md.trim() + "\n";
}

/**
 * ---------- Step 2: Structure into canonical Markdown ----------
 *
 * Input: your plain text resume (SUMMARY, PROFESSIONAL EXPERIENCE, etc.)
 * Output: canonical-ish Markdown:
 *   # Name
 *   contact | contact | ...
 *   ## Summary
 *   - bullet
 *   ## Professional Experience
 *   ### Title — Company (Loc) | Dates
 *   - bullet
 */
function structureToMarkdown(raw: string): string {
  const lines = raw.split("\n").map((l) => l.trimEnd());

  // 1) Extract name + contact from the top
  // Assume first non-empty line is name, next non-empty is contact line
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === "") idx++;
  const nameLine = (lines[idx] ?? "").trim();
  idx++;
  while (idx < lines.length && lines[idx].trim() === "") idx++;
  const contactLineRaw = (lines[idx] ?? "").trim();
  idx++;

  const contactLine = contactLineRaw
    .replace(/\t+/g, " ")
    .replace(/\s{2,}/g, " | ")
    .replace(/\s*\|\s*/g, " | ")
    .trim();

  const out: string[] = [];
  if (nameLine) {
    out.push(`# ${nameLine}`);
  }
  if (contactLine) {
    out.push(contactLine);
  }
  out.push("");

  // Known section mapping
  const sectionMap: Record<string, string> = {
    SUMMARY: "Summary",
    "PROFESSIONAL EXPERIENCE": "Professional Experience",
    EDUCATION: "Education",
    "EDUCATION:": "Education",
    "TECHNICAL KNOWLEDGE": "Technical Skills",
    "TECHNICAL KNOWLEDGE:": "Technical Skills",
    PROJECTS: "Projects",
    CERTIFICATIONS: "Certifications",
  };

  let currentSection: string | null = null;

  // For experience parsing
  // Expect pattern:
  //   Java Programmer    May 2024 – Present
  //   Ford Motor Company, MI
  //   - bullet...
  function looksLikeJobTitleWithDates(line: string): boolean {
    // Must NOT be a bullet and must contain a year-ish token or "Present"
    if (line.startsWith("- ")) return false;
    return /\b(19|20)\d{2}\b/.test(line) || /\bPresent\b/i.test(line);
  }

  function parseTitleAndDates(line: string): { title: string; dates: string } | null {
    // Split by multiple spaces or tabs (common from copy/paste)
    const parts = line
      .replace(/\t+/g, "  ")
      .split(/\s{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length < 2) return null;
    const title = parts[0];
    const dates = parts.slice(1).join(" "); // in case it got split
    return { title, dates };
  }

  // For education parsing:
  // University ... - Master ...
  // Dec 2023 | ... | GPA ...
  function looksLikeEducationInstitution(line: string): boolean {
    return /University|Institute|College|School/i.test(line) && /-/.test(line);
  }

  function parseEducationHeader(line: string, nextLine: string | null) {
    // "University ... - Master ..."
    const [instPart, degreePart] = line.split(" - ").map((s) => s.trim());
    if (!instPart || !degreePart) return null;

    // "Dec 2023 | Warrensburg, MO | GPA: 3.83/4.0"
    let date = "";
    let location = "";
    let gpa = "";
    if (nextLine) {
      const chunks = nextLine.split("|").map((s) => s.trim());
      if (chunks[0]) date = chunks[0];
      if (chunks[1]) location = chunks[1];
      const gpaChunk = chunks.find((c) => /GPA/i.test(c));
      if (gpaChunk) gpa = gpaChunk;
    }

    const headerParts = [
      instPart,
      `— ${degreePart}`,
      date ? `| ${date}` : "",
      location ? `| ${location}` : "",
    ].filter(Boolean);

    return {
      header: headerParts.join(" ").replace(/\s+\|/g, " |"),
      gpa,
    };
  }

  // For projects parsing: a line followed by bullets
  function looksLikeProjectName(line: string): boolean {
    if (!line) return false;
    if (line.startsWith("- ")) return false;
    if (Object.keys(sectionMap).includes(line.toUpperCase())) return false;
    // heuristic: short-ish and not obviously a sentence
    return line.length <= 60;
  }

  // Continue from idx (after name/contact)
  for (let i = idx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const upper = line.toUpperCase();

    // Section headings
    if (sectionMap[upper]) {
      currentSection = sectionMap[upper];
      out.push(`## ${currentSection}`);
      out.push("");
      continue;
    }

    // Default section if none found yet: Summary
    if (!currentSection) {
      currentSection = "Summary";
      out.push(`## ${currentSection}`);
      out.push("");
    }

    // Experience section structuring
    if (currentSection === "Professional Experience") {
      // Detect a job title line with dates
      if (looksLikeJobTitleWithDates(line)) {
        const parsed = parseTitleAndDates(line);
        const companyLine = (lines[i + 1] ?? "").trim();

        if (parsed && companyLine && !companyLine.startsWith("- ")) {
          // companyLine: "Ford Motor Company, MI"
          const companyParts = companyLine.split(",").map((s) => s.trim());
          const company = companyParts[0] ?? companyLine;
          const location = companyParts.slice(1).join(", ").trim() || "MI";

          out.push(
            `### ${parsed.title} — ${company} (${location}) | ${parsed.dates}`
          );
          out.push("");

          // Skip the company line
          i += 1;
          continue;
        }
      }

      // Bullets
      if (line.startsWith("- ")) {
        out.push(line);
        continue;
      }

      // If it isn't a bullet, keep it as a bullet to avoid losing info
      out.push(`- ${line}`);
      continue;
    }

    // Education structuring
    if (currentSection === "Education") {
      if (looksLikeEducationInstitution(line)) {
        const next = (lines[i + 1] ?? "").trim();
        const parsedEdu = parseEducationHeader(line, next || null);
        if (parsedEdu) {
          out.push(`### ${parsedEdu.header}`);
          if (parsedEdu.gpa) out.push(`- ${parsedEdu.gpa}`);
          out.push("");
          // Skip the next line (date/location/GPA)
          i += 1;
          continue;
        }
      }

      // fallback
      out.push(`- ${line}`);
      continue;
    }

    // Projects structuring
    if (currentSection === "Projects") {
      if (looksLikeProjectName(line) && !(lines[i + 1] ?? "").trim().startsWith("- ")) {
        // If next line isn't a bullet, treat as plain text bullet
        out.push(`- ${line}`);
        continue;
      }

      if (looksLikeProjectName(line) && (lines[i + 1] ?? "").trim().startsWith("- ")) {
        out.push(`### ${line}`);
        out.push("");
        continue;
      }

      if (line.startsWith("- ")) {
        out.push(line);
        continue;
      }

      out.push(`- ${line}`);
      continue;
    }

    // Technical Skills / Certifications / Summary:
    if (line.startsWith("- ")) {
      out.push(line);
    } else {
      // Turn plain lines into bullets to keep consistent diff structure
      out.push(`- ${line}`);
    }
  }

  // Final clean: collapse extra blank lines
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * ---------- Step 3: LOCK injection ----------
 * Now that we have # / ## / ### headings, we can safely lock the right fields.
 */
function lockValue(value: string): string {
  if (/\[\[LOCK:\s*/.test(value)) return value;
  return `[[LOCK: ${value}]]`;
}

function lockContactLine(line: string): string {
  if (/\[\[LOCK:\s*/.test(line)) return line;

  const parts = line
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length <= 1) return lockValue(line.trim());
  return parts.map((p) => lockValue(p)).join(" | ");
}

function injectLocks(md: string): { lockedMd: string; locksAdded: number } {
  md = stripBOM(md);
  const lines = md.split("\n");
  const out: string[] = [];
  let locksAdded = 0;

  const hasLock = (s: string) => /\[\[LOCK:\s*/.test(s);

  let i = 0;
  while (i < lines.length) {
    const originalLine = lines[i];

    // # Name
    const nameMatch = originalLine.match(/^(\s*)#\s+(.+)\s*$/);
    if (nameMatch && !hasLock(originalLine)) {
      const indent = nameMatch[1] ?? "";
      const name = (nameMatch[2] ?? "").trim();
      out.push(`${indent}# ${lockValue(name)}`);
      locksAdded++;

      // Contact line: next non-empty line
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") {
        out.push(lines[j]);
        j++;
      }
      if (j < lines.length && lines[j].trim() !== "") {
        out.push(lockContactLine(lines[j].trim()));
        locksAdded++;
        i = j + 1;
        continue;
      }

      i++;
      continue;
    }

    // ### Role header: Title — Company (Loc) | Dates
    const h3Match = originalLine.match(/^(\s*)###\s+(.+)\s*$/);
    if (h3Match && !hasLock(originalLine)) {
      const indent = h3Match[1] ?? "";
      const header = (h3Match[2] ?? "").trim();

      const roleMatch = header.match(
        /^(.*?)\s+[—–-]\s+(.*?)\s+\((.*?)\)\s+\|\s+(.*)$/
      );

      if (roleMatch) {
        const [, title, company, location, dates] = roleMatch;
        out.push(
          `${indent}### ${lockValue(title.trim())} — ${lockValue(
            company.trim()
          )} (${lockValue(location.trim())}) | ${lockValue(dates.trim())}`
        );
        locksAdded += 4;
        i++;
        continue;
      }

      // Otherwise lock full header (education project headers etc.)
      out.push(`${indent}### ${lockValue(header)}`);
      locksAdded++;
      i++;
      continue;
    }

    // GPA bullet: "- GPA: ..."
    const gpaMatch = originalLine.match(/^(\s*)-\s*(GPA:\s*.+)$/i);
    if (gpaMatch && !hasLock(originalLine)) {
      const indent = gpaMatch[1] ?? "";
      const gpaText = (gpaMatch[2] ?? "").trim();
      out.push(`${indent}- ${lockValue(gpaText)}`);
      locksAdded++;
      i++;
      continue;
    }

    out.push(originalLine);
    i++;
  }

  return { lockedMd: out.join("\n"), locksAdded };
}

/**
 * Main
 */
function main() {
  ensureDirs();

  console.log(`PROJECT_ROOT: ${PROJECT_ROOT}`);
  console.log(`DATA_DIR_NAME chosen: ${DATA_DIR_NAME}`);
  console.log(`INPUT_RESUME_MD: ${INPUT_RESUME_MD}`);
  console.log(`OUTPUT_NORMALIZED_MD: ${OUTPUT_NORMALIZED_MD}`);

  if (!fs.existsSync(INPUT_RESUME_MD)) {
    throw new Error(
      `resume_base.md not found.\nExpected at: ${INPUT_RESUME_MD}\n` +
        `Create it and paste your resume content there.`
    );
  }

  console.log("Reading resume_base.md...");
  const baseMd = fs.readFileSync(INPUT_RESUME_MD, "utf8");
  const bytes = Buffer.byteLength(baseMd, "utf8");
  console.log(`Read ${bytes} bytes from resume_base.md`);
  if (bytes === 0 || baseMd.trim().length === 0) {
    throw new Error(`resume_base.md is empty: ${INPUT_RESUME_MD}`);
  }

  console.log("Normalizing plain text...");
  const normalizedPlain = normalizePlainText(baseMd);

  console.log("Structuring into Markdown headings...");
  const structured = structureToMarkdown(normalizedPlain);

  console.log("Injecting LOCK markers...");
  const { lockedMd, locksAdded } = injectLocks(structured);
  console.log(`LOCK markers added: ${locksAdded}`);

  fs.writeFileSync(OUTPUT_NORMALIZED_MD, lockedMd, "utf8");

  console.log(`✅ Wrote: ${OUTPUT_NORMALIZED_MD}`);
  console.log("\nDone.");
}

main();
