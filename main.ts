// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in patch order, for the `R` output lines (section 2). */
  readonly moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 3: a file's lines, its line break, and whether it ends with one ----

/** Split a file's text at its own line break (CRLF when its first LF follows a CR, else LF). */
function fileParts(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinParts(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---- section 5: matching lines at three tiers ----

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const stripT = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return stripT(a) === stripT(b);
  const stripB = (s: string): string => stripT(s.replace(/^[ \t]+/, ''));
  return stripB(a) === stripB(b);
}

/** Every 0-based position at or after `from` where O matches the file's lines at one tier. */
function occAt(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with every occurrence there. */
function firstTier(lines: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  if (O.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occAt(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a hunk or chunk body: context, old (removed) or new (added). */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

/** One line of N (the replacement): a context line, or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  /** For a context line, its index in O, so it is written as the file's own matched line. */
  oIdx: number;
}

/** Split a body into O (context and `-` lines) and N (context and `+` lines), in body order. */
function splitOps(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const oIdx = O.length;
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIdx });
    } else if (b.kind === 'del') {
      O.push(b.text);
    } else {
      N.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

/**
 * Build the lines that replace O at position `at`: context lines are the file's own matched lines; at tier 2 every
 * other line is re-indented, replacing O's first line's leading whitespace P with the file's first matched line's F.
 */
function buildNew(N: NLine[], fileLines: string[], at: number, tier: number, O: string[]): string[] {
  const F = tier === 2 ? leadWs(fileLines[at] ?? '') : '';
  const P = tier === 2 ? leadWs(O[0] ?? '') : '';
  return N.map((e) => {
    if (e.ctx) return fileLines[at + e.oIdx]!;
    const t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

/** A `--- `/`+++ ` path: the text after the four characters, up to the first tab, spaces removed. */
function parsePatchPath(s: string): string {
  const tab = s.indexOf('\t');
  return (tab >= 0 ? s.slice(0, tab) : s).trim();
}

/** A leading `a/` or `b/` is removed from a unified-diff path. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A unified path as a file path, or null for `/dev/null` (no file). */
function toPath(p: string): string | null {
  const s = stripAB(p);
  return s === '/dev/null' ? null : s;
}

// ---- section 6: unified diffs ----

interface UnifiedHunk {
  A: number;
  /** Body lines in order; a `\` line marks the line before it as having no line break. */
  body: (BodyLine | { kind: 'bslash'; text: string })[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  /** Whether a `--- `/`+++ ` pair named the path (it beats a `rename` line). */
  pairOld: boolean;
  pairNew: boolean;
  hunks: UnifiedHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git (\S+) (\S+)$/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let curHunk: UnifiedHunk | null = null;
  let inBody = false;
  const n = lines.length;

  const finishBody = (): void => {
    if (curHunk !== null) {
      // Empty lines at the end of a body are not part of it.
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') curHunk.body.pop();
        else break;
      }
      curHunk = null;
    }
    inBody = false;
  };

  const startSection = (oldP: string | null, newP: string | null): void => {
    finishBody();
    cur = { oldPath: oldP, newPath: newP, creation: false, deletion: false, pairOld: false, pairNew: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };

  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (m === null || !m[1]!.startsWith('a/') || !m[2]!.startsWith('b/')) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!.slice(2), m[2]!.slice(2));
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = toPath(parsePatchPath(l.slice(4)));
      const newP = toPath(parsePatchPath(lines[i + 1]!.slice(4)));
      if (cur === null || !inHeader) {
        startSection(oldP, newP);
        cur!.pairOld = true;
        cur!.pairNew = true;
      } else {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pairOld = true;
        cur.pairNew = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      if (!inBody) {
        i++;
        continue;
      }
      // Inside a body a `--- ` line is a `-` line; fall through to the body below.
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      finishBody();
      curHunk = { A: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(curHunk);
      inHeader = false;
      inBody = true;
      i++;
      continue;
    }
    if (inBody && curHunk !== null) {
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        const kind = l === '' ? 'ctx' : l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'del' : l.startsWith('+') ? 'add' : 'bslash';
        const text = l === '' ? '' : kind === 'bslash' ? l : l.slice(1);
        curHunk.body.push({ kind, text } as UnifiedHunk['body'][number]);
        i++;
        continue;
      }
      finishBody();
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('+++ ')) {
        if (!cur.pairNew) {
          cur.newPath = toPath(parsePatchPath(l.slice(4)));
          cur.pairNew = true;
        }
      } else if (l.startsWith('rename from ')) {
        if (!cur.pairOld) cur.oldPath = l.slice(12).trim();
      } else if (l.startsWith('rename to ')) {
        if (!cur.pairNew) cur.newPath = l.slice(10).trim();
      } else if (l.startsWith('new file mode')) {
        cur.creation = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.deletion = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any other line:
      // ignored.
      i++;
      continue;
    }
    i++;
  }
  finishBody();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.creation || oldP === null) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusBslash = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j]!;
          if (b.kind === 'add') {
            plus.push(b.text);
            lastPlusBslash = h.body[j + 1]?.kind === 'bslash';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBslash ? '' : '\n'));
      return;
    }
    if (sec.deletion || newP === null) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    const isMove = oldP !== newP;
    if (isMove) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
    } else if (tree.get(oldP!) === null) {
      throw new Fail('missing', oldP!);
    }
    const before = tree.get(oldP!)!;
    const parts = fileParts(before);
    let lines = parts.lines;
    let final = parts.final;
    const br = parts.br;
    let d = 0;
    for (const h of sec.hunks) {
      const ops = h.body.filter((b): b is BodyLine => b.kind !== 'bslash');
      const { O, N } = splitOps(ops);
      let lastCtxAdd = -1;
      for (let j = 0; j < h.body.length; j++) {
        if (h.body[j]!.kind === 'ctx' || h.body[j]!.kind === 'add') lastCtxAdd = j;
      }
      const hasBslash = lastCtxAdd >= 0 && h.body[lastCtxAdd + 1]?.kind === 'bslash';
      if (O.length === 0) {
        const at = Math.min(h.A + d, lines.length);
        const wasAtEnd = at === lines.length;
        const ins = N.map((e) => e.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        d += N.length;
        if (wasAtEnd) final = !hasBslash;
      } else {
        const found = firstTier(lines, O, 0, strict);
        if (found === null) throw new Fail('no-match', oldP!);
        const target = h.A - 1 + d;
        let best = found.occ[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of found.occ) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const ins = buildNew(N, lines, best, found.tier, O);
        const touchesEnd = best + O.length === lines.length;
        lines = [...lines.slice(0, best), ...ins, ...lines.slice(best + O.length)];
        d += N.length - O.length;
        if (touchesEnd) final = !hasBslash;
      }
    }
    const content = joinParts(br, lines, final);
    if (isMove) {
      tree.now.set(oldP!, null);
      tree.now.set(newP!, content);
      tree.moves.push({ old: oldP!, nw: newP! });
    } else {
      tree.now.set(oldP!, content);
    }
  };
}

// ---- section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    let sep = -1;
    for (let j = sIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE' || lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = fileParts(before);
      const found = firstTier(parts.lines, oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const at = found.occ[0]!;
      const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const ins = buildNew(N, parts.lines, at, found.tier, oldLines);
      const out = [...parts.lines.slice(0, at), ...ins, ...parts.lines.slice(at + oldLines.length)];
      tree.now.set(p, joinParts(parts.br, out, parts.final));
    });
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- section 8: V4A patches ----

interface V4aChunk {
  /** The `@@` anchor line, or null for no anchor. */
  anchor: string | null;
  /** True when a `*** End of File` line ended this chunk. */
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!l.startsWith('*** Add File: ') && !l.startsWith('*** Delete File: ') && !l.startsWith('*** Update File: ')) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    const isAdd = l.startsWith('*** Add File: ');
    const isDelete = l.startsWith('*** Delete File: ');
    const path = l.slice(l.indexOf(':') + 1).trim();
    // The section's lines run to the next section header or `*** End Patch`; trailing blank lines are not part of it.
    let j = i + 1;
    while (j < last && !lines[j]!.startsWith('*** Add File: ') && !lines[j]!.startsWith('*** Delete File: ') && !lines[j]!.startsWith('*** Update File: ')) {
      j++;
    }
    const raw: { text: string; no: number }[] = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k]!, no: k + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (isAdd) {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (isDelete) {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let rest = raw;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      let firstChunk = true;
      for (const r of rest) {
        const cl = r.text;
        if (cl.startsWith('@@')) {
          const a = cl.slice(2).trim();
          curChunk = { anchor: a === '' ? null : a, eof: false, body: [] };
          chunks.push(curChunk);
          firstChunk = false;
        } else if (cl === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${r.no}`);
          curChunk.eof = true;
          curChunk = null;
        } else if (cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+') || cl === '') {
          if (curChunk === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${r.no}`);
            curChunk = { anchor: null, eof: false, body: [] };
            chunks.push(curChunk);
            firstChunk = false;
          }
          const kind = cl === '' ? 'ctx' : cl.startsWith(' ') ? 'ctx' : cl.startsWith('-') ? 'del' : 'add';
          const text = cl === '' ? '' : cl.slice(1);
          curChunk.body.push({ kind, text });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const parts = fileParts(before);
        let linesNow = parts.lines;
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            const found = firstTier(linesNow, [ch.anchor], cursor, strict);
            if (found === null) throw new Fail('no-match', p);
            cursor = found.occ[0]! + 1;
          }
          const { O, N } = splitOps(ch.body);
          if (O.length === 0) {
            const at = ch.eof ? linesNow.length : cursor;
            const ins = N.map((e) => e.text);
            linesNow = [...linesNow.slice(0, at), ...ins, ...linesNow.slice(at)];
            cursor = at + ins.length;
          } else {
            const tiers = strict ? [0] : [0, 1, 2];
            let chosen: { tier: number; at: number } | null = null;
            for (const t of tiers) {
              const occ = occAt(linesNow, O, t, cursor);
              const cand = ch.eof ? occ.filter((pos) => pos + O.length === linesNow.length) : occ;
              if (cand.length > 0) {
                chosen = { tier: t, at: cand[0]! };
                break;
              }
            }
            if (chosen === null) throw new Fail('no-match', p);
            const ins = buildNew(N, linesNow, chosen.at, chosen.tier, O);
            linesNow = [...linesNow.slice(0, chosen.at), ...ins, ...linesNow.slice(chosen.at + O.length)];
            cursor = chosen.at + ins.length;
          }
        }
        const content = joinParts(parts.br, linesNow, parts.final);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, content);
          tree.moves.push({ old: p, nw: mt });
        } else {
          tree.now.set(p, content);
        }
      });
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move edit whose old path existed before the patch and is gone now, and whose new path did not exist before the
  // patch and does now, is reported as `R <old> -> <new>` instead of that pair's `D` and `A` lines, sorting by <new>.
  const moveNew = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.get(m.nw) !== null) moveNew.set(m.nw, m.old);
  }
  const suppressed = new Set<string>(moveNew.values());
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && now !== null && moveNew.has(p)) {
      rows.push({ key: p, line: `R ${moveNew.get(p)} -> ${p}` });
    } else if (was !== null && now === null && suppressed.has(p)) {
      continue;
    } else {
      rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
