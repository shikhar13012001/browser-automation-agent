export type Item = {
  id: number;
  kind: string;
  label: string;
  section?: string;
  value?: string;
  checked?: boolean;
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  hint?: string;
  expanded?: boolean;
  selected?: boolean;
  hidden?: boolean;
  inDialog?: boolean;
  inPopup?: boolean;
  lines?: number;
  chrome?: boolean;
  group?: string;
  options?: string[];
  optionsMore?: number;
  inputType?: string;
  href?: string;
  readonly?: boolean;
  hoverMenu?: boolean;
};

export type FrameData = {
  items: Item[];
  headings: string[];
  errors: string[];
  messages?: string[];
  dialogs: string[];
  popups?: string[];
  chromeHidden: number;
  gen: string;
  title: string;
  url: string;
  text?: string;
  summary?: string;
};

export type PageInfo = { tabIndex: number; tabCount: number };

function q(s: string): string {
  return JSON.stringify(s ?? "");
}

function shortHref(href: string, pageUrl: string): string {
  if (!href || href.startsWith("javascript:")) return "";
  try {
    const u = new URL(href, pageUrl);
    const base = new URL(pageUrl);
    const s = u.host === base.host ? u.pathname + u.search : u.host + u.pathname;
    return s.length > 60 ? s.slice(0, 59) + "…" : s;
  } catch {
    return "";
  }
}

// Many sites mark required fields only visually ("Email *"); treat a trailing asterisk as required
// and drop it from the label so it isn't printed twice.
function splitRequired(label: string): { label: string; starred: boolean } {
  const m = label.match(/^(.*?)\s*\*+\s*$/);
  return m ? { label: m[1], starred: true } : { label, starred: false };
}

export function formatItem(it: Item, pageUrl: string): string {
  const { label, starred } = splitRequired(it.label ?? "");
  let s = `[${it.id}] ${it.kind}`;
  if (it.inputType) s += `:${it.inputType}`;
  s += ` ${q(label)}`;
  if (it.required || starred) s += " *";
  switch (it.kind) {
    case "checkbox":
    case "switch":
      s += it.checked ? " [x]" : " [ ]";
      break;
    case "radio":
      s += it.checked ? " (o)" : " ( )";
      break;
    case "select":
      s += ` = ${q(it.value ?? "")}`;
      if (it.options?.length) {
        s += ` options: ${it.options.join(" | ")}`;
        if (it.optionsMore) s += ` (+${it.optionsMore} more; select by label)`;
      }
      break;
    case "link": {
      const h = shortHref(it.href ?? "", pageUrl);
      if (h) s += ` -> ${h}`;
      break;
    }
    case "button":
    case "tab":
    case "option":
    case "menuitem":
      break;
    case "code":
      s += ` (${it.lines ?? 0} lines; fill replaces all of it) = ${q(it.value ?? "")}`;
      break;
    default:
      if (it.value !== undefined) s += ` = ${q(it.value)}`;
  }
  if (it.selected) s += " (selected)";
  if (it.expanded) s += " (open)";
  if (it.disabled) s += " (disabled)";
  if (it.readonly && !it.disabled) s += " (read-only: click it to open its picker)";
  if (it.hoverMenu) s += " (menu: click to open)";
  if (it.hidden && it.kind === "file") s += " (hidden input: use upload)";
  if (it.invalid) s += it.hint ? ` (INVALID: ${it.hint})` : " (INVALID)";
  return s;
}

// Groups items under their section heading, prints radio/checkbox groups once, and lists any
// blocking dialog first because nothing else on the page can be clicked until it's handled.
export function formatState(frames: FrameData[], info: PageInfo): string {
  const main = frames[0];
  const lines: string[] = [];
  lines.push(`PAGE ${q(main.title)} ${main.url}`);
  if (info.tabCount > 1) lines.push(`TAB ${info.tabIndex + 1} of ${info.tabCount}`);

  const all = frames.flatMap((f) => f.items);
  const dialogs = frames.flatMap((f) => f.dialogs).filter(Boolean);
  const errors = frames.flatMap((f) => f.errors).filter(Boolean);

  // While a blocking dialog is open, only its elements are listed. Anything behind it can't be used,
  // and touching it usually closes the dialog -- listing it invited the model to click "New booking"
  // again on every turn, closing and re-creating the very form it was filling.
  const inDialog = all.filter((i) => i.inDialog);
  const blocked = dialogs.length > 0 && inDialog.length > 0;
  if (dialogs.length) lines.push(`DIALOG ${dialogs.map((d) => q(d)).join(", ")} is open -- work inside it:`);
  if (errors.length) lines.push(`ERRORS: ${errors.map((e) => q(e)).join(" | ")}`);
  const messages = frames.flatMap((f) => f.messages ?? []).filter(Boolean);
  if (messages.length) lines.push(`MESSAGES: ${messages.map((m) => q(m)).join(" | ")}`);
  const popupItems = blocked ? [] : all.filter((i) => i.inPopup);
  if (popupItems.length) {
    const names = frames.flatMap((f) => f.popups ?? []).filter(Boolean);
    lines.push(`POPUP ${names.length ? names.map((n) => q(n.slice(0, 40))).join(", ") + " " : ""}is open -- pick from it or press Escape:`);
    for (const it of popupItems) lines.push("  " + formatItem(it, main.url));
  }
  const shown = blocked ? inDialog : all.filter((i) => !i.inPopup);
  if (blocked) {
    const behind = all.length - inDialog.length;
    if (behind) lines.push(`(${behind} elements behind the dialog are hidden until it closes)`);
  }

  let lastSection: string | undefined;
  let lastGroup: string | undefined;
  for (const it of shown) {
    const sec = it.section ?? "";
    if (sec !== lastSection) {
      if (sec) lines.push(`## ${sec}`);
      lastSection = sec;
      lastGroup = undefined;
    }
    // A legend is already printed as the section heading; only print the group line when it adds info.
    const groupLabel = it.group ? splitRequired(it.group).label : "";
    const grouped = (it.kind === "radio" || it.kind === "checkbox") && groupLabel && groupLabel !== splitRequired(sec).label;
    if (grouped && it.group !== lastGroup) {
      lines.push(`? ${q(groupLabel)}`);
      lastGroup = it.group;
    } else if (!grouped) {
      lastGroup = undefined;
    }
    lines.push((grouped ? "  " : "") + formatItem(it, main.url));
  }

  const hidden = frames.reduce((n, f) => n + (f.chromeHidden || 0), 0);
  if (hidden) lines.push(`(${hidden} header/nav/footer links hidden; call state with all=true only if you need them)`);
  // Confirmation, error and "thank you" pages have little or nothing to click; show what they say.
  if (all.length < 4) {
    const heads = main.headings.slice(0, 5);
    if (heads.length) lines.push(`HEADINGS: ${heads.map((h) => q(h)).join(" | ")}`);
    if (main.summary && !main.text) lines.push(`TEXT: ${main.summary}`);
  }
  if (!all.length && !main.headings.length && !main.summary) lines.push("(page is empty so far -- it may still be loading; call state again, or use look)");
  for (const f of frames) if (f.text) lines.push(`TEXT: ${f.text}`);
  return lines.join("\n");
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Picks the best option for a requested value: exact label, then exact value, then prefix, then
// substring, then word overlap. Returns -1 when nothing plausible matches so the caller can list
// the real options instead of guessing.
// Minutes since midnight for the first time in a string ("2:00 PM", "2 pm", "14:00", "02:00 p.m.").
// Needs a colon or am/pm so plain numbers ("3-5 years") are never read as times.
export function timeOf(s: string): number | undefined {
  const m = s.match(/\b(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?\.?|\b(\d{1,2})\s*([ap])\.?\s*m\b\.?/i);
  if (!m) return undefined;
  let h = Number(m[1] ?? m[4]);
  const min = Number(m[2] ?? 0);
  const ap = (m[3] ?? m[5] ?? "").toLowerCase();
  if (h > 23 || min > 59) return undefined;
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return h * 60 + min;
}

export function bestOptionIndex(options: { label: string; value?: string }[], wanted: string): number {
  const w = norm(wanted);
  if (!w) return -1;
  const labels = options.map((o) => norm(o.label));
  const values = options.map((o) => norm(o.value ?? ""));
  let i = labels.indexOf(w);
  if (i >= 0) return i;
  i = values.indexOf(w);
  if (i >= 0) return i;
  // Times before substring matching: "2:00" is a substring of "12:00".
  const t = timeOf(wanted);
  if (t !== undefined) {
    i = options.findIndex((o) => timeOf(o.label) === t);
    if (i >= 0) return i;
  }
  i = labels.findIndex((l) => l.startsWith(w));
  if (i >= 0) return i;
  i = labels.findIndex((l) => l.includes(w));
  if (i >= 0) return i;
  i = labels.findIndex((l) => l.length > 1 && w.includes(l));
  if (i >= 0) return i;
  const words = w.split(/[^a-z0-9+]+/).filter((x) => x.length > 1);
  let best = -1;
  let bestScore = 0;
  labels.forEach((l, idx) => {
    const score = words.filter((x) => l.includes(x)).length;
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  });
  return bestScore > 0 ? best : -1;
}
