// Merges the QA findings of every run in a batch into one list of distinct issues. Different
// personas describe the same bug in different words ("City is cleared after Back" vs "Going back
// loses the city"), so findings are grouped by word overlap in their titles, keeping the worst
// severity and counting how many runs hit each one -- a bug five personas hit matters more than one.

export type Finding = {
  severity?: string;
  category?: string;
  title?: string;
  url?: string;
  steps?: string[];
  expected?: string;
  actual?: string;
};

export type RunForReport = {
  id: string;
  label: string;
  status: string;
  cost?: number;
  findings: Finding[];
};

export type Issue = {
  title: string;
  severity: string;
  category: string;
  hits: number;
  runs: string[];
  example: Finding;
  variants: string[];
};

export type BatchReport = {
  runs: number;
  byStatus: Record<string, number>;
  cost: number;
  findings: number;
  issues: Issue[];
};

const SEVERITY = ["critical", "major", "minor", "suggestion"];
const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "on", "in", "and", "or", "for", "when", "after", "with", "not", "be", "it", "its", "field", "page", "button", "form"]);

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9+ ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, "")),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let same = 0;
  for (const w of a) if (b.has(w)) same++;
  return same / Math.min(a.size, b.size);
}

function rank(sev?: string): number {
  const i = SEVERITY.indexOf((sev ?? "").toLowerCase());
  return i < 0 ? SEVERITY.length : i;
}

export function findingsOf(resultJson: unknown): Finding[] {
  const f = (resultJson as { findings?: unknown } | null | undefined)?.findings;
  return Array.isArray(f) ? (f.filter((x) => x && typeof x === "object") as Finding[]) : [];
}

export function buildBatchReport(runs: RunForReport[], threshold = 0.6): BatchReport {
  const groups: { key: Set<string>; issue: Issue }[] = [];
  let findings = 0;
  for (const run of runs) {
    for (const f of run.findings) {
      findings++;
      const title = (f.title ?? f.actual ?? "Untitled finding").trim();
      const key = words(`${title} ${f.category ?? ""}`);
      let best: { key: Set<string>; issue: Issue } | undefined;
      let bestScore = 0;
      for (const g of groups) {
        const s = overlap(key, g.key);
        if (s > bestScore) {
          best = g;
          bestScore = s;
        }
      }
      if (best && bestScore >= threshold) {
        const is = best.issue;
        if (!is.runs.includes(run.label)) {
          is.runs.push(run.label);
          is.hits++;
        }
        if (!is.variants.includes(title) && is.variants.length < 5) is.variants.push(title);
        if (rank(f.severity) < rank(is.severity)) {
          is.severity = (f.severity ?? is.severity).toLowerCase();
          is.example = f;
        }
        for (const w of key) best.key.add(w);
      } else {
        groups.push({
          key,
          issue: { title, severity: (f.severity ?? "minor").toLowerCase(), category: f.category ?? "bug", hits: 1, runs: [run.label], example: f, variants: [title] },
        });
      }
    }
  }
  const byStatus: Record<string, number> = {};
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const issues = groups.map((g) => g.issue).sort((a, b) => rank(a.severity) - rank(b.severity) || b.hits - a.hits);
  return { runs: runs.length, byStatus, cost: runs.reduce((n, r) => n + (r.cost ?? 0), 0), findings, issues };
}
