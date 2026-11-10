/**
 * Caption model, parsers and writers for SRT, WebVTT, ASS/SSA, JSON and plain text.
 * All times are integer milliseconds.
 */

export interface Cue {
  start: number;
  end: number;
  /** Lines separated by "\n". May contain inline tags (<i>, {\an8}) as in the source. */
  text: string;
}

export type CaptionFormat = "srt" | "vtt" | "ass" | "json" | "txt";

export interface ParseResult {
  format: CaptionFormat;
  cues: Cue[];
  warnings: string[];
}

/* ---------------------------------------------------------------- time */

export function parseTime(raw: string): number {
  const s = raw.trim().replace(",", ".");
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) throw new Error(`Bad timestamp "${raw}"`);
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`Bad timestamp "${raw}"`);
  const [h, m, sec] = nums.length === 3 ? nums : [0, nums[0], nums[1]];
  return Math.round((h * 3600 + m * 60 + sec) * 1000);
}

/** Accepts ms numbers, "12.5s", "1500ms", "00:01:02,500", "-2.5" (seconds). */
export function parseOffset(value: string | number): number {
  if (typeof value === "number") return Math.round(value);
  const v = value.trim();
  const neg = v.startsWith("-");
  const body = neg || v.startsWith("+") ? v.slice(1) : v;
  let ms: number;
  if (/^\d+(\.\d+)?ms$/.test(body)) ms = Number(body.slice(0, -2));
  else if (/^\d+(\.\d+)?s?$/.test(body)) ms = Number(body.replace(/s$/, "")) * 1000;
  else ms = parseTime(body);
  return Math.round(neg ? -ms : ms);
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}

function split(ms: number) {
  const t = Math.max(0, Math.round(ms));
  return { h: Math.floor(t / 3600000), m: Math.floor((t % 3600000) / 60000), s: Math.floor((t % 60000) / 1000), ms: t % 1000 };
}

export function fmtSrt(ms: number) {
  const x = split(ms);
  return `${pad(x.h)}:${pad(x.m)}:${pad(x.s)},${pad(x.ms, 3)}`;
}

export function fmtVtt(ms: number) {
  const x = split(ms);
  return `${pad(x.h)}:${pad(x.m)}:${pad(x.s)}.${pad(x.ms, 3)}`;
}

export function fmtAss(ms: number) {
  const x = split(Math.round(ms / 10) * 10);
  return `${x.h}:${pad(x.m)}:${pad(x.s)}.${pad(Math.floor(x.ms / 10))}`;
}

/* ---------------------------------------------------------------- text helpers */

/** Remove HTML-ish tags, ASS override blocks and VTT voice/timestamp tags. */
export function plainText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

export function lineLengths(text: string): number[] {
  return plainText(text)
    .split("\n")
    .map((l) => [...l].length);
}

/** Characters per second, counting every visible character except line breaks. */
export function cps(cue: Cue): number {
  const chars = [...plainText(cue.text).replace(/\n/g, " ")].length;
  const secs = (cue.end - cue.start) / 1000;
  return secs > 0 ? chars / secs : Infinity;
}

/* ---------------------------------------------------------------- detection */

export function detectFormat(content: string, fileName?: string): CaptionFormat {
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext === "srt" || ext === "vtt" || ext === "json" || ext === "txt") return ext;
  if (ext === "ass" || ext === "ssa") return "ass";
  const head = content.replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("WEBVTT")) return "vtt";
  if (/^\[Script Info\]/im.test(head) || /^Dialogue:/m.test(head)) return "ass";
  if (head.startsWith("[") || head.startsWith("{")) {
    try {
      JSON.parse(head);
      return "json";
    } catch {
      /* fall through */
    }
  }
  if (head.includes("-->")) return "srt";
  return "txt";
}

/* ---------------------------------------------------------------- parsers */

const ARROW = /(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}/;

function normalize(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function parseArrowLine(line: string): { start: number; end: number } {
  const m = line.match(ARROW);
  if (!m) throw new Error(`No timing in "${line}"`);
  const [a, b] = m[0].split("-->");
  return { start: parseTime(a), end: parseTime(b) };
}

export function parseSrt(content: string): ParseResult {
  const warnings: string[] = [];
  const cues: Cue[] = [];
  const blocks = normalize(content).split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ""));
    const idx = lines.findIndex((l) => ARROW.test(l));
    if (idx === -1) {
      if (block.trim()) warnings.push(`Skipped a block without timing: "${block.trim().slice(0, 40)}"`);
      continue;
    }
    const { start, end } = parseArrowLine(lines[idx]);
    const text = lines.slice(idx + 1).join("\n").trim();
    cues.push({ start, end, text });
  }
  return { format: "srt", cues, warnings };
}

export function parseVtt(content: string): ParseResult {
  const warnings: string[] = [];
  const cues: Cue[] = [];
  const blocks = normalize(content).split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith("WEBVTT") || /^(NOTE|STYLE|REGION)\b/.test(trimmed)) {
      // a WEBVTT header block may still be followed directly by a cue without a blank line
      if (!(trimmed.startsWith("WEBVTT") && ARROW.test(trimmed))) continue;
    }
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => ARROW.test(l));
    if (idx === -1) continue;
    const { start, end } = parseArrowLine(lines[idx]);
    const text = lines
      .slice(idx + 1)
      .join("\n")
      .trim()
      // inline karaoke timestamps <00:00:01.000>
      .replace(/<\d{1,2}:\d{2}(:\d{2})?\.\d{3}>/g, "")
      .replace(/<\/?c(\.[\w.-]+)?>/g, "");
    cues.push({ start, end, text });
  }
  return { format: "vtt", cues, warnings };
}

export function parseAss(content: string): ParseResult {
  const warnings: string[] = [];
  const cues: Cue[] = [];
  let fields = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
  let inEvents = false;
  for (const line of normalize(content).split("\n")) {
    const l = line.trim();
    if (/^\[.*\]$/.test(l)) {
      inEvents = l.toLowerCase() === "[events]";
      continue;
    }
    if (!inEvents) continue;
    if (l.startsWith("Format:")) {
      fields = l.slice(7).split(",").map((f) => f.trim());
      continue;
    }
    if (!l.startsWith("Dialogue:")) continue;
    const body = l.slice(9).trimStart();
    const parts: string[] = [];
    let rest = body;
    for (let i = 0; i < fields.length - 1; i++) {
      const c = rest.indexOf(",");
      if (c === -1) break;
      parts.push(rest.slice(0, c));
      rest = rest.slice(c + 1);
    }
    parts.push(rest);
    const get = (name: string) => parts[fields.findIndex((f) => f.toLowerCase() === name.toLowerCase())] ?? "";
    try {
      const text = get("Text").replace(/\\N/g, "\n").replace(/\\n/g, "\n").replace(/\\h/g, " ");
      cues.push({ start: parseTime(get("Start")), end: parseTime(get("End")), text });
    } catch {
      warnings.push(`Skipped unreadable Dialogue line: ${l.slice(0, 60)}`);
    }
  }
  return { format: "ass", cues, warnings };
}

export function parseJson(content: string): ParseResult {
  const data = JSON.parse(content);
  const arr: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.cues) ? data.cues : Array.isArray(data?.segments) ? data.segments : [];
  if (!arr.length) throw new Error("JSON must be an array of cues, or an object with a cues or segments array.");
  const toMs = (v: unknown, isMs: boolean): number => {
    if (typeof v === "number") return Math.round(isMs ? v : v * 1000);
    if (typeof v === "string") return parseTime(v);
    throw new Error("Cue is missing start/end.");
  };
  const cues = arr.map((raw) => {
    const c = raw as Record<string, unknown>;
    const hasMs = c.start_ms !== undefined;
    return {
      start: toMs(hasMs ? c.start_ms : c.start, hasMs),
      end: toMs(hasMs ? c.end_ms : c.end, hasMs),
      text: String(c.text ?? "").trim(),
    };
  });
  return { format: "json", cues, warnings: [] };
}

export function parseCaptions(content: string, format?: CaptionFormat, fileName?: string): ParseResult {
  const f = format ?? detectFormat(content, fileName);
  let res: ParseResult;
  switch (f) {
    case "srt":
      res = parseSrt(content);
      break;
    case "vtt":
      res = parseVtt(content);
      break;
    case "ass":
      res = parseAss(content);
      break;
    case "json":
      res = parseJson(content);
      break;
    default:
      throw new Error("Could not recognise caption format. Supported input: SRT, WebVTT, ASS/SSA, JSON.");
  }
  if (res.cues.length === 0) throw new Error(`No cues found in this ${f.toUpperCase()} input.`);
  return res;
}

/* ---------------------------------------------------------------- writers */

export interface AssStyle {
  playResX: number;
  playResY: number;
  font: string;
  fontSize: number;
  /** #RRGGBB */
  primaryColor: string;
  outlineColor: string;
  outline: number;
  shadow: number;
  bold: boolean;
  /** Numpad position: 2 = bottom center, 5 = middle center, 8 = top center. */
  alignment: number;
  marginV: number;
  borderStyle: 1 | 3;
}

export const DEFAULT_ASS_STYLE: AssStyle = {
  playResX: 1920,
  playResY: 1080,
  font: "Arial",
  fontSize: 64,
  primaryColor: "#FFFFFF",
  outlineColor: "#000000",
  outline: 3,
  shadow: 0,
  bold: true,
  alignment: 2,
  marginV: 60,
  borderStyle: 1,
};

function assColor(hex: string): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "&H00FFFFFF";
  const [, r, g, b] = m;
  return `&H00${b}${g}${r}`.toUpperCase();
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(c.end)}\n${c.text}\n`).join("\n");
}

export function toVtt(cues: Cue[]): string {
  return "WEBVTT\n\n" + cues.map((c) => `${fmtVtt(c.start)} --> ${fmtVtt(c.end)}\n${c.text}\n`).join("\n");
}

export function toAss(cues: Cue[], style: Partial<AssStyle> = {}): string {
  const s = { ...DEFAULT_ASS_STYLE, ...style };
  const header = [
    "[Script Info]",
    "; Generated by caption-forge-mcp",
    "ScriptType: v4.00+",
    `PlayResX: ${s.playResX}`,
    `PlayResY: ${s.playResY}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${s.font},${s.fontSize},${assColor(s.primaryColor)},&H000000FF,${assColor(s.outlineColor)},&H64000000,${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.borderStyle},${s.outline},${s.shadow},${s.alignment},40,40,${s.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.map((c) => `Dialogue: 0,${fmtAss(c.start)},${fmtAss(c.end)},Default,,0,0,0,,${c.text.replace(/\n/g, "\\N")}`);
  return [...header, ...events, ""].join("\n");
}

export function toJson(cues: Cue[]): string {
  return JSON.stringify(
    cues.map((c, i) => ({ index: i + 1, start: fmtVtt(c.start), end: fmtVtt(c.end), start_ms: c.start, end_ms: c.end, text: c.text })),
    null,
    2,
  );
}

export function toTxt(cues: Cue[]): string {
  return transcript(cues, {}).text;
}

export function serialize(cues: Cue[], format: CaptionFormat, assStyle?: Partial<AssStyle>): string {
  switch (format) {
    case "srt":
      return toSrt(cues);
    case "vtt":
      return toVtt(cues);
    case "ass":
      return toAss(cues, assStyle);
    case "json":
      return toJson(cues);
    case "txt":
      return toTxt(cues);
  }
}

/* ---------------------------------------------------------------- transcript */

export interface TranscriptOptions {
  paragraphGapMs?: number;
  timestamps?: boolean;
  stripSpeakerTags?: boolean;
}

/** Plain transcript; paragraphs break on long pauses; rolling duplicate lines (auto captions) are removed. */
export function transcript(cues: Cue[], o: TranscriptOptions): { text: string; paragraphs: { start: number; text: string }[] } {
  const gap = o.paragraphGapMs ?? 2000;
  const paragraphs: { start: number; text: string }[] = [];
  let current: string[] = [];
  let currentStart = 0;
  let lastLine = "";
  let lastEnd = -Infinity;
  for (const c of cues) {
    let lines = plainText(c.text).split("\n").filter(Boolean);
    if (o.stripSpeakerTags) lines = lines.map((l) => l.replace(/^(-\s*)?[A-Z][A-Z0-9 .'-]{1,24}:\s*/, "").replace(/^-\s+/, ""));
    if (current.length && c.start - lastEnd >= gap) {
      paragraphs.push({ start: currentStart, text: current.join(" ") });
      current = [];
    }
    for (const line of lines) {
      if (line === lastLine) continue;
      if (!current.length) currentStart = c.start;
      current.push(line);
      lastLine = line;
    }
    lastEnd = Math.max(lastEnd, c.end);
  }
  if (current.length) paragraphs.push({ start: currentStart, text: current.join(" ") });
  const text = paragraphs.map((p) => (o.timestamps ? `[${fmtVtt(p.start).slice(0, 8)}] ${p.text}` : p.text)).join("\n\n");
  return { text, paragraphs };
}
