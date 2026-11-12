// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/chemistry/abbreviations/catalog.rs and define.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Nicknames: labels a chemist types as one word for a group (Bpin, TBDPS, Morph, MeO), each with its structure.
// Octet's own (nicknamedata.ts, from ReShiki's catalogue) and the user's own (Structure > Define Nickname, kept in
// the settings and in a nicknames file to share). labels.ts reads a label through lookupNickname, so formula, mass,
// SMILES, Expand Label and CDXML export know every nickname. No chemistry here: nicknamedefine.ts checks structures.
import { BUNDLED } from "./nicknamedata.ts";

// A nickname. smiles: its structure, the first atom bonded to the drawing (no "*"); formula: the group's, Hill order
// with its charge after it (C6H12BO2, NO2, C3H9N+). reverse: the label as it reads with the bond to its right (MeO for
// OMe), which typed also makes it. aliases: other spellings, kept as typed (TBDMS for TBS). names: what it is called,
// never typed as a label (morpholino). contract: false for a group that is only typed. user: one of the user's own.
export type Nickname = { label: string; reverse?: string; smiles: string; formula: string; category: string; names: string[]; aliases?: string[]; contract?: false; user?: true };
export type Spelling = "label" | "alias" | "reverse";
export { BUNDLED };
export const NICKNAMES_FORMAT = 1, MOST_NICKNAMES = 500, NICKNAME_LENGTH = 32;
// ReShiki's 14 categories, in the order Choose Nickname shows them, then the user's.
export const CATEGORIES = ["alkyl", "aryl", "heteroaryl", "alkoxy", "carbonyl", "protecting group", "silyl", "sulfonyl", "sulfur", "nitrogen",
  "phosphorus", "boron", "halogen", "metal", "user"];

type Index = { spelled: Map<string, [Nickname, Spelling]>; reversed: Map<string, Nickname> };
const index = (list: Nickname[]): Index => {
  const spelled = new Map<string, [Nickname, Spelling]>(), reversed = new Map<string, Nickname>();
  for (const e of list) {
    if (!spelled.has(e.label)) spelled.set(e.label, [e, "label"]);
    for (const a of e.aliases ?? []) if (!spelled.has(a)) spelled.set(a, [e, "alias"]);
    if (e.reverse && !reversed.has(e.reverse)) reversed.set(e.reverse, e);
  }
  return { spelled, reversed };
};
const bundled = index(BUNDLED);
let mine: Nickname[] = [], own = index([]), merged: Nickname[] = BUNDLED;
// Called when the user's nicknames change (labels.ts forgets how it split labels).
const listeners: (() => void)[] = [];
export const onNicknamesChange = (f: () => void) => { listeners.push(f); };

// The user's nicknames, as the settings keep them. A user nickname with the label of one of Octet's takes its place.
export function setUserNicknames(list: Nickname[]) {
  if (list === mine) return;
  mine = list;
  const users = list.slice(0, MOST_NICKNAMES).map((e): Nickname => ({ ...e, user: true }));
  own = index(users);
  const replaced = new Set(users.map((e) => e.label));
  merged = [...BUNDLED.map((e) => (replaced.has(e.label) ? users.find((u) => u.label === e.label)! : e)), ...users.filter((u) => !bundled.spelled.has(u.label) || bundled.spelled.get(u.label)![1] !== "label")];
  for (const f of listeners) f();
}
export const userNicknames = () => mine;
// Octet's nicknames with the user's in their place, then the user's other ones.
export const allNicknames = () => merged;

// The nickname a typed spelling makes, and how it was spelled. Case counts (Mes and MeS differ). The user's label or
// alias first, then Octet's, then the user's reverse spelling, then Octet's (as ReShiki's lookup).
export function lookupNickname(text: string): { entry: Nickname; spelling: Spelling } | undefined {
  const hit = own.spelled.get(text) ?? bundled.spelled.get(text);
  if (hit) return { entry: hit[0], spelling: hit[1] };
  const r = own.reversed.get(text) ?? bundled.reversed.get(text);
  return r && { entry: r, spelling: "reverse" };
}
// Octet's nickname for a spelling, whatever the user has.
export function bundledNickname(text: string): Nickname | undefined {
  return bundled.spelled.get(text)?.[0] ?? bundled.reversed.get(text);
}

// Labels whose names include this text, ignoring case ("morpholino" gives Morph, "acetyl" gives Ac and COMe). A name is
// never a label itself.
export function namedNicknames(text: string): string[] {
  const t = text.trim().toLowerCase();
  if (!t) return [];
  return [...new Set(merged.filter((e) => e.names.some((n) => n.toLowerCase() === t)).map((e) => e.label))];
}

// A label, reverse label or alias as a nickname takes it: 1 to 32 characters, no spaces, control characters or commas.
// The message, or undefined when it is good.
export function spellingProblem(text: string, what: string, optional = false): string | undefined {
  if (!text && optional) return undefined;
  return !text || [...text].length > NICKNAME_LENGTH || /[\s,\u0000-\u001f\u007f-\u009f]/.test(text) ? `${what} "${text}" must have 1 to ${NICKNAME_LENGTH} characters, with no spaces or commas.` : undefined;
}

// ——— The nicknames file (ReShiki's format 1, so the two programs share files) ———
// {"format": 1, "groups": [{"label": "Piv", "smiles": "*C(=O)C(C)(C)C", "formula": "C5H9O", ...}]}. Each SMILES starts
// with "*", the attachment.
const FIELDS = new Set(["label", "reverse", "smiles", "formula", "category", "names", "aliases", "contract"]);
export const MAX_FILE = 1024 * 1024;
export type Checker = (e: Nickname) => string | undefined;
// The nicknames in a file, each checked by check (the chemistry, nicknamedefine.ts checkNickname), and a message for
// each one left out: "Group 3 (Foo): …". A spelling used twice is left out the second time. The file must be JSON
// with format 1.
export function readNicknamesFile(text: string, check: Checker): { nicknames: Nickname[]; errors: string[] } {
  let file: unknown;
  if (text.length > MAX_FILE) return { nicknames: [], errors: ["The file is larger than 1 MB."] };
  try { file = JSON.parse(text); } catch { return { nicknames: [], errors: ["The file is not a nicknames file (JSON)."] }; }
  const f = file as { format?: unknown; groups?: unknown };
  if (!f || typeof f !== "object" || !Array.isArray(f.groups)) return { nicknames: [], errors: ["The file is not a nicknames file: it has no groups."] };
  if (f.format !== NICKNAMES_FORMAT) return { nicknames: [], errors: [`Octet cannot read nicknames file format ${String(f.format)}. It reads format ${NICKNAMES_FORMAT}.`] };
  const out: Nickname[] = [], errors: string[] = [], seen = new Set<string>();
  f.groups.slice(0, MOST_NICKNAMES * 4).forEach((raw, k) => {
    const label = raw && typeof raw === "object" && typeof (raw as { label?: unknown }).label === "string" ? (raw as { label: string }).label.slice(0, 40) : "?";
    const fail = (why: string) => errors.push(`Group ${k + 1} (${label}): ${why}`);
    const e = entryOf(raw);
    if (typeof e === "string") return fail(e);
    const spellings = [e.label, ...(e.aliases ?? []), ...(e.reverse ? [e.reverse] : [])];
    const twice = spellings.find((s, i) => seen.has(s) || spellings.indexOf(s) !== i);
    if (twice) return fail(`"${twice}" is defined twice.`);
    const why = check(e);
    if (why) return fail(why);
    if (out.length >= MOST_NICKNAMES) return fail(`Octet keeps at most ${MOST_NICKNAMES} nicknames.`);
    spellings.forEach((s) => seen.add(s));
    out.push(e);
  });
  return { nicknames: out, errors };
}
// One group of a file as a nickname (its SMILES without the "*"), or what is wrong with its fields.
function entryOf(raw: unknown): Nickname | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "It is not a group.";
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !FIELDS.has(k));
  if (extra) return `Octet does not know the field "${extra}".`;
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string") && v.length <= 50;
  if (typeof o.label !== "string" || typeof o.smiles !== "string") return "A group needs a label and a SMILES.";
  if ((o.reverse !== undefined && typeof o.reverse !== "string") || (o.formula !== undefined && typeof o.formula !== "string") || (o.category !== undefined && typeof o.category !== "string")
    || (o.names !== undefined && !strings(o.names)) || (o.aliases !== undefined && !strings(o.aliases)) || (o.contract !== undefined && typeof o.contract !== "boolean")) return "A field has the wrong type.";
  const smiles = o.smiles.trim();
  if (smiles.length > 2000) return "The SMILES is too long.";
  if (!smiles.startsWith("*") || smiles.indexOf("*", 1) >= 0) return "The SMILES must start with the one * attachment point.";
  const reverse = (o.reverse as string | undefined) || undefined, aliases = (o.aliases as string[] | undefined)?.filter(Boolean);
  const bad = spellingProblem(o.label, "Label") ?? spellingProblem(reverse ?? "", "Reverse label", true) ?? aliases?.map((a) => spellingProblem(a, "Alias")).find(Boolean);
  if (bad) return bad;
  return {
    label: o.label, ...(reverse ? { reverse } : {}), smiles: smiles.slice(1), formula: (o.formula as string | undefined) ?? "", category: "user",
    names: ((o.names as string[] | undefined) ?? []).map((n) => n.slice(0, 200)), ...(aliases?.length ? { aliases } : {}), ...(o.contract === false ? { contract: false as const } : {}),
  };
}
// The user's nicknames as a file.
export function nicknamesFile(list: Nickname[]): string {
  const row = (e: Nickname) => JSON.stringify({ label: e.label, ...(e.reverse ? { reverse: e.reverse } : {}), smiles: `*${e.smiles}`, formula: e.formula, category: "user",
    ...(e.names.length ? { names: e.names } : {}), ...(e.aliases?.length ? { aliases: e.aliases } : {}), ...(e.contract === false ? { contract: false } : {}) });
  return `{\n  "format": ${NICKNAMES_FORMAT},\n  "groups": [\n${list.map((e) => `    ${row(e)}`).join(",\n")}\n  ]\n}\n`;
}

// ——— Changes to the user's list, as Define Nickname and Settings > Nicknames make them ———
const strip = ({ user: _, ...e }: Nickname): Nickname => e;
// A nickname added: it takes the place of the user's nickname with the same label, else it goes last. The list back
// unchanged when it is full.
export function withNickname(list: Nickname[], e: Nickname): Nickname[] {
  const at = list.findIndex((n) => n.label === e.label), next = { ...strip(e), category: "user" };
  return at >= 0 ? list.map((n, i) => (i === at ? next : n)) : list.length < MOST_NICKNAMES ? [...list, next] : list;
}
export const withoutNickname = (list: Nickname[], label: string) => list.filter((n) => n.label !== label);
// Nicknames from a file, after the user's: a label the user has already keeps the user's structure.
export function mergeNicknames(list: Nickname[], more: Nickname[]): { list: Nickname[]; added: number; kept: number } {
  let next = list, added = 0, kept = 0;
  for (const e of more) {
    if (next.some((n) => n.label === e.label)) { kept++; continue; }
    const after = withNickname(next, e);
    if (after !== next) added++;
    next = after;
  }
  return { list: next, added, kept };
}
// The user's nicknames as the settings keep them (no "*" before the SMILES): each well formed, at most 500.
export function readNicknameList(v: unknown): Nickname[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): Nickname[] => {
    if (!x || typeof x !== "object") return [];
    const e = entryOf({ ...(x as object), smiles: `*${String((x as { smiles?: unknown }).smiles ?? "")}`, category: undefined });
    return typeof e === "string" || !e.smiles ? [] : [e];
  }).slice(0, MOST_NICKNAMES);
}
