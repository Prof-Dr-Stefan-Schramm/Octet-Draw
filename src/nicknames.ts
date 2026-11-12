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

