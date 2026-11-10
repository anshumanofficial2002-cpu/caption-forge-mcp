/** Timing, linting, cleaning and re-chunking operations on cues. */
import { cps, fmtVtt, lineLengths, plainText, type Cue } from "./captions.js";

/* ---------------------------------------------------------------- shift / retime */

export function shift(cues: Cue[], offsetMs: number, fromMs = 0): { cues: Cue[]; dropped: number } {
  let dropped = 0;
  const out: Cue[] = [];
  for (const c of cues) {
    if (c.start < fromMs) {
      out.push({ ...c });
      continue;
    }
    const start = c.start + offsetMs;
    const end = c.end + offsetMs;
    if (end <= 0) {
      dropped++;
      continue;
    }
    out.push({ ...c, start: Math.max(0, start), end });
  }
  return { cues: out, dropped };
}

/** Linear retime: t' = t * factor + offset. */
export function linearRetime(cues: Cue[], factor: number, offsetMs = 0): Cue[] {
  return cues.map((c) => ({ ...c, start: Math.max(0, Math.round(c.start * factor + offsetMs)), end: Math.max(0, Math.round(c.end * factor + offsetMs)) }));
}

/** Two-point sync: map time a1 → b1 and a2 → b2, everything else linearly. */
export function twoPointSync(cues: Cue[], a1: number, b1: number, a2: number, b2: number): { cues: Cue[]; factor: number; offset: number } {
  if (a1 === a2) throw new Error("The two sync points must be at different original times.");
  const factor = (b2 - b1) / (a2 - a1);
  const offset = b1 - a1 * factor;
  return { cues: linearRetime(cues, factor, offset), factor, offset };
}

export const FPS_PRESETS: Record<string, number> = {
  "23.976": 24000 / 1001,
  "24": 24,
  "25": 25,
  "29.97": 30000 / 1001,
  "30": 30,
  "50": 50,
  "59.94": 60000 / 1001,
  "60": 60,
};

/* ---------------------------------------------------------------- lint */

export interface LintRules {
  max_chars_per_line: number;
  max_lines: number;
  max_cps: number;
  min_duration_ms: number;
  max_duration_ms: number;
  min_gap_ms: number;
}

export const LINT_PRESETS: Record<string, LintRules> = {
  // Common broadcast/streaming practice for adult content.
  standard: { max_chars_per_line: 42, max_lines: 2, max_cps: 17, min_duration_ms: 833, max_duration_ms: 7000, min_gap_ms: 83 },
  // Fast, punchy social captions: short single lines that change often.
  reels: { max_chars_per_line: 24, max_lines: 1, max_cps: 22, min_duration_ms: 300, max_duration_ms: 3000, min_gap_ms: 0 },
  // Slower reading speed, e.g. children's content or accessibility-first.
  accessible: { max_chars_per_line: 37, max_lines: 2, max_cps: 13, min_duration_ms: 1500, max_duration_ms: 7000, min_gap_ms: 83 },
};

export interface LintIssue {
  cue: number;
  time: string;
  rule: string;
  severity: "error" | "warning";
  message: string;
  text: string;
}

export function lint(cues: Cue[], rules: LintRules): LintIssue[] {
  const issues: LintIssue[] = [];
  cues.forEach((c, i) => {
    const n = i + 1;
    const time = fmtVtt(c.start);
    const text = plainText(c.text).replace(/\n/g, " / ");
    const add = (rule: string, severity: LintIssue["severity"], message: string) => issues.push({ cue: n, time, rule, severity, message, text });
    if (!plainText(c.text)) add("empty", "error", "Cue has no text.");
    if (c.end <= c.start) add("zero_duration", "error", `End (${fmtVtt(c.end)}) is not after start.`);
    const lens = lineLengths(c.text);
    if (lens.length > rules.max_lines) add("too_many_lines", "warning", `${lens.length} lines (max ${rules.max_lines}).`);
    const longest = Math.max(0, ...lens);
    if (longest > rules.max_chars_per_line) add("line_too_long", "warning", `Line of ${longest} characters (max ${rules.max_chars_per_line}).`);
    const dur = c.end - c.start;
    if (dur > 0 && dur < rules.min_duration_ms) add("too_short", "warning", `On screen ${dur} ms (min ${rules.min_duration_ms}).`);
    if (dur > rules.max_duration_ms) add("too_long", "warning", `On screen ${(dur / 1000).toFixed(1)} s (max ${(rules.max_duration_ms / 1000).toFixed(1)}).`);
    const rate = cps(c);
    if (dur > 0 && rate > rules.max_cps) add("reading_speed", "warning", `${rate.toFixed(1)} characters/second (max ${rules.max_cps}). Viewers may not finish reading it.`);
    const next = cues[i + 1];
    if (next) {
      if (next.start < c.start) add("out_of_order", "error", `Next cue starts earlier (${fmtVtt(next.start)}).`);
      else if (next.start < c.end) add("overlap", "error", `Overlaps the next cue by ${c.end - next.start} ms.`);
      else if (next.start - c.end < rules.min_gap_ms && next.start !== c.end) add("small_gap", "warning", `Gap to next cue is ${next.start - c.end} ms (min ${rules.min_gap_ms}). Flicker risk.`);
    }
  });
  return issues;
}

/* ---------------------------------------------------------------- clean */

export interface CleanOptions {
  min_gap_ms: number;
  min_duration_ms: number;
  merge_duplicates: boolean;
  remove_hearing_impaired: boolean;
}

export function clean(input: Cue[], o: CleanOptions): { cues: Cue[]; changes: string[] } {
  const changes: string[] = [];
  let cues = input.map((c) => ({ ...c, text: c.text.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n") }));

  if (o.remove_hearing_impaired) {
    let n = 0;
    cues = cues.map((c) => {
      const t = c.text
        .split("\n")
        .map((l) => l.replace(/\[[^\]]*\]|\([^)]*\)|♪+/g, "").replace(/^[A-Z][A-Z0-9 .'-]{1,24}:\s*/, "").trim())
        .filter(Boolean)
        .join("\n");
      if (t !== c.text) n++;
      return { ...c, text: t };
    });
    if (n) changes.push(`Removed sound descriptions / speaker labels from ${n} cue(s).`);
  }

  const before = cues.length;
  cues = cues.filter((c) => plainText(c.text).length > 0 && c.end > c.start);
  if (cues.length !== before) changes.push(`Removed ${before - cues.length} empty or zero-length cue(s).`);

  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.some((c, i) => c !== cues[i])) changes.push("Sorted cues by start time.");
  cues = sorted;

  if (o.merge_duplicates) {
    const merged: Cue[] = [];
    let m = 0;
    for (const c of cues) {
      const prev = merged[merged.length - 1];
      if (prev && prev.text === c.text && c.start - prev.end <= 250) {
        prev.end = Math.max(prev.end, c.end);
        m++;
      } else merged.push({ ...c });
    }
    if (m) changes.push(`Merged ${m} back-to-back duplicate cue(s).`);
    cues = merged;
  }

  let overlaps = 0;
  let extended = 0;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    if (next && c.end > next.start - o.min_gap_ms) {
      const newEnd = Math.max(c.start + 1, next.start - o.min_gap_ms);
      if (newEnd !== c.end) {
        c.end = newEnd;
        overlaps++;
      }
    }
    if (c.end - c.start < o.min_duration_ms) {
      const limit = next ? next.start - o.min_gap_ms : Infinity;
      const target = Math.min(c.start + o.min_duration_ms, limit);
      if (target > c.end) {
        c.end = target;
        extended++;
      }
    }
  }
  if (overlaps) changes.push(`Fixed ${overlaps} overlap(s)/tight gap(s) (min gap ${o.min_gap_ms} ms).`);
  if (extended) changes.push(`Extended ${extended} too-short cue(s) toward ${o.min_duration_ms} ms where there was room.`);
  if (!changes.length) changes.push("Nothing needed fixing.");
  return { cues, changes };
}

/* ---------------------------------------------------------------- reflow */

export interface ReflowOptions {
  max_chars_per_line: number;
  max_lines: number;
  max_words: number;
  uppercase: boolean;
  strip_punctuation: boolean;
  min_duration_ms: number;
}

interface Word {
  text: string;
  start: number;
  end: number;
}

const BREAK_AFTER = /[.!?…]["')\]]*$|[,;:–—]$/;

/** Distribute a cue's time across its words, weighted by length. */
function wordsOf(c: Cue): Word[] {
  const tokens = plainText(c.text).replace(/\n/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const weights = tokens.map((t) => [...t].length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const dur = c.end - c.start;
  let acc = 0;
  return tokens.map((t, i) => {
    const start = c.start + Math.round((acc / total) * dur);
    acc += weights[i];
    const end = c.start + Math.round((acc / total) * dur);
    return { text: t, start, end };
  });
}

function stylize(text: string, o: Pick<ReflowOptions, "uppercase" | "strip_punctuation">): string {
  let t = text;
  if (o.strip_punctuation) t = t.replace(/[.,;:"“”]+/g, "").replace(/\s+/g, " ").trim();
  if (o.uppercase) t = t.toLocaleUpperCase();
  return t;
}

/** Break text into at most maxLines lines of ≤ maxChars, splitting near the middle. */
export function balanceLines(text: string, maxChars: number, maxLines: number): string {
  const len = [...text].length;
  if (len <= maxChars || maxLines < 2) return text;
  const words = text.split(" ");
  let best = -1;
  let bestScore = Infinity;
  let pos = 0;
  for (let i = 0; i < words.length - 1; i++) {
    pos += [...words[i]].length + (i > 0 ? 1 : 0);
    const left = pos;
    const right = len - pos - 1;
    if (left > maxChars || right > maxChars) continue;
    // prefer balanced lines, and breaking after punctuation
    const score = Math.abs(left - right) - (BREAK_AFTER.test(words[i]) ? 8 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best === -1) return text;
  return `${words.slice(0, best + 1).join(" ")}\n${words.slice(best + 1).join(" ")}`;
}

/** Group words into caption chunks honoring word/char limits and natural phrase breaks. */
function chunkWords(words: Word[], o: ReflowOptions): Word[][] {
  const capacity = o.max_chars_per_line * o.max_lines;
  const chunks: Word[][] = [];
  let cur: Word[] = [];
  let curLen = 0;
  for (const w of words) {
    const wl = [...w.text].length;
    const nextLen = cur.length ? curLen + 1 + wl : wl;
    if (cur.length && (cur.length >= o.max_words || nextLen > capacity)) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(w);
    curLen = cur.length === 1 ? wl : curLen + 1 + wl;
    // natural break: sentence end always; comma-ish once the chunk is half full
    if (/[.!?…]["')\]]*$/.test(w.text) || (/[,;:–—]$/.test(w.text) && curLen >= capacity / 2)) {
      chunks.push(cur);
      cur = [];
      curLen = 0;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function reflowWords(words: Word[], o: ReflowOptions): Cue[] {
  const out: Cue[] = [];
  for (const chunk of chunkWords(words, o)) {
    const raw = chunk.map((w) => w.text).join(" ");
    const text = balanceLines(stylize(raw, o), o.max_chars_per_line, o.max_lines);
    if (!text) continue;
    out.push({ start: chunk[0].start, end: chunk[chunk.length - 1].end, text });
  }
  // enforce minimum on-screen time by borrowing from the gap after, never overlapping
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c.end - c.start < o.min_duration_ms) {
      const limit = out[i + 1]?.start ?? Infinity;
      c.end = Math.min(c.start + o.min_duration_ms, limit);
    }
  }
  return out;
}

export function reflow(cues: Cue[], o: ReflowOptions): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) out.push(...reflowWords(wordsOf(c), o));
  return out;
}

/* ---------------------------------------------------------------- word-level input */

/**
 * Accepts word timestamps from common speech-to-text tools:
 *  - [{ word|text, start, end }]                 (seconds)
 *  - [{ word|text, start_ms, end_ms }]
 *  - Whisper / faster-whisper JSON: { segments: [{ words: [{ word, start, end }] }] }
 *  - Deepgram-style: { results: { channels: [{ alternatives: [{ words: [...] }] }] } }
 */
export function parseWordTimestamps(json: unknown): Word[] {
  const pick = (d: unknown): unknown[] => {
    if (Array.isArray(d)) {
      if (d.length && (d[0] as Record<string, unknown>)?.words) return d.flatMap((s) => ((s as Record<string, unknown>).words as unknown[]) ?? []);
      return d;
    }
    const o = d as Record<string, any>;
    if (Array.isArray(o?.words)) return o.words;
    if (Array.isArray(o?.segments)) return o.segments.flatMap((s: Record<string, unknown>) => (s.words as unknown[]) ?? []);
    const dg = o?.results?.channels?.[0]?.alternatives?.[0]?.words;
    if (Array.isArray(dg)) return dg;
    return [];
  };
  const raw = pick(json);
  if (!raw.length) throw new Error("No word timestamps found. Expected an array of {word, start, end} or Whisper/Deepgram JSON with word timings.");
  const words: Word[] = [];
  for (const r of raw) {
    const w = r as Record<string, unknown>;
    const text = String(w.punctuated_word ?? w.word ?? w.text ?? "").trim();
    if (!text) continue;
    const isMs = w.start_ms !== undefined;
    const s = Number(isMs ? w.start_ms : w.start);
    const e = Number(isMs ? w.end_ms : w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    words.push({ text, start: Math.round(isMs ? s : s * 1000), end: Math.round(isMs ? e : e * 1000) });
  }
  return words.sort((a, b) => a.start - b.start);
}

/* ---------------------------------------------------------------- search */

export interface SearchHit {
  cue: number;
  start: string;
  end: string;
  start_ms: number;
  text: string;
  context_before?: string;
  context_after?: string;
}

export function search(cues: Cue[], query: string, o: { regex: boolean; wholeWord: boolean; context: number }): SearchHit[] {
  const flags = "iu";
  let re: RegExp;
  if (o.regex) re = new RegExp(query, flags);
  else {
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(o.wholeWord ? `(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])` : esc, flags);
  }
  const hits: SearchHit[] = [];
  cues.forEach((c, i) => {
    const t = plainText(c.text).replace(/\n/g, " ");
    if (!re.test(t)) return;
    const hit: SearchHit = { cue: i + 1, start: fmtVtt(c.start), end: fmtVtt(c.end), start_ms: c.start, text: t };
    if (o.context > 0) {
      hit.context_before = cues.slice(Math.max(0, i - o.context), i).map((x) => plainText(x.text).replace(/\n/g, " ")).join(" ");
      hit.context_after = cues.slice(i + 1, i + 1 + o.context).map((x) => plainText(x.text).replace(/\n/g, " ")).join(" ");
    }
    hits.push(hit);
  });
  return hits;
}

/* ---------------------------------------------------------------- stats */

export function stats(cues: Cue[]) {
  const rates = cues.map(cps).filter(Number.isFinite);
  const durs = cues.map((c) => c.end - c.start);
  const allLens = cues.flatMap((c) => lineLengths(c.text));
  const words = cues.reduce((n, c) => n + plainText(c.text).split(/\s+/).filter(Boolean).length, 0);
  const span = cues.length ? cues[cues.length - 1].end - cues[0].start : 0;
  const onScreen = durs.reduce((a, b) => a + Math.max(0, b), 0);
  return {
    cues: cues.length,
    first_start: cues.length ? fmtVtt(cues[0].start) : null,
    last_end: cues.length ? fmtVtt(Math.max(...cues.map((c) => c.end))) : null,
    span_seconds: +(span / 1000).toFixed(2),
    on_screen_seconds: +(onScreen / 1000).toFixed(2),
    words,
    words_per_minute: span > 0 ? Math.round(words / (span / 60000)) : 0,
    avg_cps: rates.length ? +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1) : 0,
    max_cps: rates.length ? +Math.max(...rates).toFixed(1) : 0,
    avg_duration_ms: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0,
    min_duration_ms: durs.length ? Math.min(...durs) : 0,
    max_duration_ms: durs.length ? Math.max(...durs) : 0,
    longest_line_chars: allLens.length ? Math.max(...allLens) : 0,
    max_lines_in_a_cue: cues.length ? Math.max(...cues.map((c) => plainText(c.text).split("\n").length)) : 0,
    has_formatting_tags: cues.some((c) => /<[^>]+>|\{\\[^}]*\}/.test(c.text)),
  };
}
