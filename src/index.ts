#!/usr/bin/env node
/**
 * caption-forge-mcp — convert, time, lint and restyle subtitles from any MCP client.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fmtVtt, parseOffset, plainText, transcript, type AssStyle, type CaptionFormat, type Cue } from "./lib/captions.js";
import { emit, inlineBlock, loadCaptions, readText, writeOutput } from "./lib/io.js";
import {
  clean, FPS_PRESETS, linearRetime, lint, LINT_PRESETS, parseWordTimestamps, reflow, reflowWords, search, shift, stats, twoPointSync, type LintRules, type ReflowOptions,
} from "./lib/ops.js";
import { guard, markdownTable, ok } from "./lib/tool.js";

const VERSION = "1.0.0";

const server = new McpServer(
  { name: "caption-forge-mcp", version: VERSION },
  {
    instructions:
      "Subtitle and caption tools. Every tool accepts either `path` (a local .srt/.vtt/.ass/.json file) or `content` (the caption text itself). " +
      "Results are returned inline unless `output_path` is given, in which case the file is written (never overwriting without overwrite: true). " +
      "Use reflow_captions or captions_from_words for short, punchy reel-style captions; lint_captions to check readability before delivery.",
  },
);

/* ---------------------------------------------------------------- shared schema bits */

const formatEnum = z.enum(["srt", "vtt", "ass", "json", "txt"]);
const input = {
  path: z.string().optional().describe("Local caption file (.srt, .vtt, .ass/.ssa, .json). ~ is expanded."),
  content: z.string().optional().describe("Caption text, if you don't have a file."),
  format: z.enum(["srt", "vtt", "ass", "json"]).optional().describe("Input format. Detected automatically when omitted."),
};
const output = {
  output_path: z.string().optional().describe("Write the result here. Format follows the extension unless `to` is set. Omit to get the text back inline."),
  overwrite: z.boolean().default(false).describe("Allow replacing an existing file."),
};
const toFormat = formatEnum.optional().describe("Output format. Defaults to the input format (or the output_path extension).");

const assStyleSchema = z
  .object({
    preset: z.enum(["vertical_reel", "horizontal", "lower_third"]).optional().describe("vertical_reel: 1080x1920, big bold centered text above the UI zone. horizontal: 1920x1080 bottom subtitles. lower_third: 1920x1080, smaller, bottom-left feel."),
    font: z.string().optional(),
    font_size: z.number().positive().optional(),
    primary_color: z.string().optional().describe("#RRGGBB"),
    outline_color: z.string().optional().describe("#RRGGBB"),
    outline: z.number().min(0).optional(),
    shadow: z.number().min(0).optional(),
    bold: z.boolean().optional(),
    alignment: z.number().int().min(1).max(9).optional().describe("Numpad position: 2 bottom-center, 5 middle-center, 8 top-center."),
    margin_v: z.number().int().min(0).optional().describe("Vertical margin in pixels from the aligned edge."),
    box: z.boolean().optional().describe("Opaque box behind text instead of an outline."),
  })
  .optional()
  .describe("Styling for ASS output (used when burning captions into video).");

function resolveAssStyle(s: z.infer<typeof assStyleSchema>): Partial<AssStyle> {
  const presets: Record<string, Partial<AssStyle>> = {
    vertical_reel: { playResX: 1080, playResY: 1920, fontSize: 84, alignment: 2, marginV: 520, outline: 5, bold: true },
    horizontal: { playResX: 1920, playResY: 1080, fontSize: 64, alignment: 2, marginV: 60 },
    lower_third: { playResX: 1920, playResY: 1080, fontSize: 48, alignment: 1, marginV: 80, outline: 2 },
  };
  if (!s) return {};
  return {
    ...(s.preset ? presets[s.preset] : {}),
    ...(s.font && { font: s.font }),
    ...(s.font_size && { fontSize: s.font_size }),
    ...(s.primary_color && { primaryColor: s.primary_color }),
    ...(s.outline_color && { outlineColor: s.outline_color }),
    ...(s.outline !== undefined && { outline: s.outline }),
    ...(s.shadow !== undefined && { shadow: s.shadow }),
    ...(s.bold !== undefined && { bold: s.bold }),
    ...(s.alignment && { alignment: s.alignment }),
    ...(s.margin_v !== undefined && { marginV: s.margin_v }),
    ...(s.box && { borderStyle: 3 as const }),
  };
}

function burnInHint(format: CaptionFormat, written?: string): string {
  if (format !== "ass" && format !== "srt") return "";
  const sub = written ?? `captions.${format}`;
  const esc = sub.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  return `\n\nBurn into a video with ffmpeg:\n\`\`\`sh\nffmpeg -i input.mp4 -vf "subtitles='${esc}'" -c:a copy output_captioned.mp4\n\`\`\``;
}

async function respond(
  title: string,
  cues: Cue[],
  opts: { to?: CaptionFormat; fallback: CaptionFormat; output_path?: string; overwrite?: boolean; inputFile?: string; assStyle?: Partial<AssStyle>; extra?: string; data?: Record<string, unknown> },
) {
  const res = await emit(cues, opts);
  const head = `${title}\n${cues.length} cue(s), ${res.format.toUpperCase()}.${opts.extra ? `\n${opts.extra}` : ""}`;
  if (res.written) return ok(`${head}\nSaved to ${res.written}${burnInHint(res.format, res.written)}`, { output: res.written, format: res.format, cues: cues.length, ...opts.data });
  return ok(`${head}\n\n${inlineBlock(res.text, res.format)}`);
}

/* ---------------------------------------------------------------- tools */

server.registerTool(
  "caption_info",
  {
    title: "Caption file info",
    description:
      "Summarize a caption file: detected format, cue count, time span, word count and speaking rate, average/max reading speed (characters per second), " +
      "shortest/longest cue, longest line, lines per cue, formatting tags, and parse warnings. Shows the first few cues.",
    inputSchema: { ...input, preview: z.number().int().min(0).max(50).default(5).describe("How many cues to preview.") },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const s = stats(p.cues);
      const preview = p.cues.slice(0, a.preview).map((c, i) => [i + 1, fmtVtt(c.start), fmtVtt(c.end), plainText(c.text).replace(/\n/g, " / ")]);
      const text =
        `**${p.source}** — ${p.format.toUpperCase()}, ${s.cues} cues, ${s.first_start} → ${s.last_end} (${s.span_seconds}s)\n` +
        `${s.words} words · ~${s.words_per_minute} wpm · reading speed avg ${s.avg_cps} / max ${s.max_cps} cps · longest line ${s.longest_line_chars} chars · up to ${s.max_lines_in_a_cue} line(s) per cue\n` +
        (p.warnings.length ? `\nParse warnings:\n${p.warnings.map((w) => `- ${w}`).join("\n")}\n` : "") +
        (preview.length ? `\n${markdownTable(["#", "start", "end", "text"], preview)}` : "");
      return ok(text, { format: p.format, ...s, warnings: p.warnings });
    }),
);

server.registerTool(
  "convert_captions",
  {
    title: "Convert caption formats",
    description:
      "Convert between SRT, WebVTT, ASS (styled, for burning in), JSON and plain-text transcript. ASS output can be styled with presets " +
      "(vertical_reel, horizontal, lower_third) or custom font, size, colors, outline, box and position, and comes with an ffmpeg burn-in command.",
    inputSchema: { ...input, to: formatEnum.describe("Target format."), ass_style: assStyleSchema, ...output },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const assStyle = resolveAssStyle(a.ass_style);
      return respond(`Converted ${p.source} (${p.format.toUpperCase()}) → ${a.to.toUpperCase()}.`, p.cues, {
        to: a.to,
        fallback: a.to,
        output_path: a.output_path,
        overwrite: a.overwrite,
        inputFile: p.file,
        assStyle,
      });
    }),
);

server.registerTool(
  "shift_captions",
  {
    title: "Shift caption timing",
    description:
      "Move every cue earlier or later by a fixed offset — the fix for captions that are consistently ahead of or behind the audio. " +
      "Optionally only shift cues from a given time onward (e.g. after an ad break or a cut).",
    inputSchema: {
      ...input,
      offset: z.union([z.number(), z.string()]).describe('Positive = later, negative = earlier. Number = milliseconds, or a string like "2.5s", "-1500ms", "-00:00:01,200".'),
      from: z.string().optional().describe('Only shift cues starting at or after this time, e.g. "00:12:30" or "750s".'),
      output_format: toFormat,
      ...output,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const offset = parseOffset(a.offset);
      const fromMs = a.from ? Math.max(0, parseOffset(a.from)) : 0;
      const r = shift(p.cues, offset, fromMs);
      const extra = `${offset >= 0 ? "+" : ""}${offset} ms${fromMs ? ` from ${fmtVtt(fromMs)} on` : ""}${r.dropped ? `. ${r.dropped} cue(s) moved before 0 and were dropped.` : ""}`;
      return respond(`Shifted ${p.source}.`, r.cues, { to: a.output_format, fallback: p.format, output_path: a.output_path, overwrite: a.overwrite, inputFile: p.file, extra });
    }),
);

server.registerTool(
  "retime_captions",
  {
    title: "Retime / resync captions",
    description:
      "Fix captions that drift (in sync at the start, increasingly off later). Three modes: " +
      "fps — convert between frame rates (e.g. 23.976 → 25 PAL speed-up); factor — stretch by a multiplier; " +
      "sync_points — give the correct time for two cues and everything is mapped linearly between them (most accurate).",
    inputSchema: {
      ...input,
      mode: z.enum(["fps", "factor", "sync_points"]),
      from_fps: z.enum(["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"]).optional().describe("mode=fps: frame rate the captions were timed for."),
      to_fps: z.enum(["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"]).optional().describe("mode=fps: frame rate of the video they should match."),
      factor: z.number().positive().optional().describe("mode=factor: multiply all times by this."),
      sync_points: z
        .object({
          first_original: z.string().describe("Original time of an early cue, e.g. 00:00:05,100"),
          first_correct: z.string().describe("Where that cue should be."),
          second_original: z.string().describe("Original time of a late cue."),
          second_correct: z.string().describe("Where that cue should be."),
        })
        .optional(),
      output_format: toFormat,
      ...output,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      let cues: Cue[];
      let extra: string;
      if (a.mode === "fps") {
        if (!a.from_fps || !a.to_fps) throw new Error("mode=fps needs from_fps and to_fps.");
        const f = FPS_PRESETS[a.from_fps] / FPS_PRESETS[a.to_fps];
        cues = linearRetime(p.cues, f);
        extra = `Frame-rate conversion ${a.from_fps} → ${a.to_fps} fps (times × ${f.toFixed(6)}).`;
      } else if (a.mode === "factor") {
        if (!a.factor) throw new Error("mode=factor needs factor.");
        cues = linearRetime(p.cues, a.factor);
        extra = `Times × ${a.factor}.`;
      } else {
        const s = a.sync_points;
        if (!s) throw new Error("mode=sync_points needs sync_points.");
        const r = twoPointSync(p.cues, parseOffset(s.first_original), parseOffset(s.first_correct), parseOffset(s.second_original), parseOffset(s.second_correct));
        cues = r.cues;
        extra = `Linear map: t × ${r.factor.toFixed(6)} ${r.offset >= 0 ? "+" : "−"} ${Math.abs(Math.round(r.offset))} ms.`;
      }
      return respond(`Retimed ${p.source}.`, cues, { to: a.output_format, fallback: p.format, output_path: a.output_path, overwrite: a.overwrite, inputFile: p.file, extra });
    }),
);

const rulesOverride = {
  max_chars_per_line: z.number().int().positive().optional(),
  max_lines: z.number().int().positive().optional(),
  max_cps: z.number().positive().optional().describe("Max reading speed in characters per second."),
  min_duration_ms: z.number().int().nonnegative().optional(),
  max_duration_ms: z.number().int().positive().optional(),
  min_gap_ms: z.number().int().nonnegative().optional(),
};

server.registerTool(
  "lint_captions",
  {
    title: "Lint captions for readability",
    description:
      "Check captions against readability rules and list every problem with its cue number and timestamp: lines too long, too many lines, " +
      "reading speed too fast (CPS), on screen too briefly or too long, overlaps, out-of-order cues, flicker-prone gaps and empty cues. " +
      "Presets: standard (42 chars × 2 lines, 17 cps — common streaming practice), reels (24 chars × 1 line), accessible (13 cps). Any rule can be overridden.",
    inputSchema: { ...input, preset: z.enum(["standard", "reels", "accessible"]).default("standard"), ...rulesOverride, max_issues: z.number().int().min(1).max(2000).default(200) },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const rules: LintRules = { ...LINT_PRESETS[a.preset] };
      for (const k of Object.keys(rulesOverride) as (keyof LintRules)[]) if (a[k] !== undefined) rules[k] = a[k]!;
      const issues = lint(p.cues, rules);
      const counts: Record<string, number> = {};
      for (const i of issues) counts[i.rule] = (counts[i.rule] ?? 0) + 1;
      const errors = issues.filter((i) => i.severity === "error").length;
      const shown = issues.slice(0, a.max_issues);
      const head = issues.length
        ? `${issues.length} issue(s) in ${p.cues.length} cues (${errors} error(s)): ${Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join(", ")}`
        : `No issues in ${p.cues.length} cues. ✅`;
      const table = shown.length ? `\n\n${markdownTable(["cue", "time", "rule", "problem", "text"], shown.map((i) => [i.cue, i.time.slice(0, 12), i.rule, i.message, i.text.slice(0, 80)]))}` : "";
      const more = issues.length > shown.length ? `\n(${issues.length - shown.length} more not shown)` : "";
      const hint = issues.length ? "\n\nTip: clean_captions fixes overlaps, gaps and short cues; reflow_captions fixes long lines and fast reading speed." : "";
      return ok(head + table + more + hint, { rules, total: issues.length, errors, by_rule: counts, issues: shown });
    }),
);

server.registerTool(
  "clean_captions",
  {
    title: "Clean up captions",
    description:
      "Automatic tidy-up: trims whitespace, drops empty and zero-length cues, sorts by time, merges back-to-back duplicates, fixes overlaps and " +
      "flicker gaps, extends too-short cues where there is room, renumbers. Optionally removes sound descriptions like [MUSIC] or (laughs) and speaker labels.",
    inputSchema: {
      ...input,
      min_gap_ms: z.number().int().min(0).max(1000).default(83).describe("Minimum gap between cues (83 ms ≈ 2 frames at 24 fps)."),
      min_duration_ms: z.number().int().min(0).max(5000).default(833),
      merge_duplicates: z.boolean().default(true),
      remove_hearing_impaired: z.boolean().default(false).describe("Strip [SOUND], (sound), ♪ and 'SPEAKER:' labels."),
      output_format: toFormat,
      ...output,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const r = clean(p.cues, a);
      return respond(`Cleaned ${p.source}.`, r.cues, { to: a.output_format, fallback: p.format, output_path: a.output_path, overwrite: a.overwrite, inputFile: p.file, extra: r.changes.map((c) => `- ${c}`).join("\n") });
    }),
);

const reflowSchema = {
  style: z.enum(["reels", "standard", "custom"]).default("reels").describe("reels: 1–3 words per caption, one short line. standard: up to 42 chars × 2 balanced lines. custom: use the limits below."),
  max_words: z.number().int().min(1).max(40).optional().describe("Max words per caption (reels default 3)."),
  max_chars_per_line: z.number().int().min(4).max(80).optional(),
  max_lines: z.number().int().min(1).max(3).optional(),
  uppercase: z.boolean().optional().describe("ALL CAPS captions (reels default: false)."),
  strip_punctuation: z.boolean().optional().describe("Drop periods, commas and quotes, keep ? and ! (reels default: true)."),
  min_duration_ms: z.number().int().min(0).max(3000).optional(),
};

function reflowOptions(a: { style: "reels" | "standard" | "custom"; max_words?: number; max_chars_per_line?: number; max_lines?: number; uppercase?: boolean; strip_punctuation?: boolean; min_duration_ms?: number }): ReflowOptions {
  const base: ReflowOptions =
    a.style === "reels"
      ? { max_words: 3, max_chars_per_line: 22, max_lines: 1, uppercase: false, strip_punctuation: true, min_duration_ms: 250 }
      : { max_words: 40, max_chars_per_line: 42, max_lines: 2, uppercase: false, strip_punctuation: false, min_duration_ms: 833 };
  return {
    max_words: a.max_words ?? base.max_words,
    max_chars_per_line: a.max_chars_per_line ?? base.max_chars_per_line,
    max_lines: a.max_lines ?? base.max_lines,
    uppercase: a.uppercase ?? base.uppercase,
    strip_punctuation: a.strip_punctuation ?? base.strip_punctuation,
    min_duration_ms: a.min_duration_ms ?? base.min_duration_ms,
  };
}

server.registerTool(
  "reflow_captions",
  {
    title: "Re-chunk captions (reel style or standard)",
    description:
      "Rebuild caption chunks from existing cues. reels: short 1–3 word punchy captions like on Instagram/TikTok/Shorts, timed by splitting each cue's " +
      "duration across its words. standard: rewrap into balanced ≤42-character lines, max 2 per cue, splitting overlong cues. Breaks prefer sentence and phrase boundaries.",
    inputSchema: { ...input, ...reflowSchema, output_format: toFormat, ass_style: assStyleSchema, ...output },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const o = reflowOptions(a);
      const cues = reflow(p.cues, o);
      const assStyle = resolveAssStyle(a.ass_style ?? (a.style === "reels" ? { preset: "vertical_reel" } : undefined));
      return respond(`Reflowed ${p.source} (${p.cues.length} → ${cues.length} cues, ${a.style}).`, cues, {
        to: a.output_format,
        fallback: p.format,
        output_path: a.output_path,
        overwrite: a.overwrite,
        inputFile: p.file,
        assStyle,
        extra: `Limits: ${o.max_words} words, ${o.max_chars_per_line} chars × ${o.max_lines} line(s)${o.uppercase ? ", uppercase" : ""}${o.strip_punctuation ? ", punctuation stripped" : ""}. Timing within each original cue is estimated from word length — for exact word timing, use captions_from_words with word timestamps.`,
      });
    }),
);

server.registerTool(
  "captions_from_words",
  {
    title: "Captions from word timestamps",
    description:
      "Build frame-accurate captions from word-level timestamps produced by speech-to-text (Whisper / faster-whisper / WhisperX JSON with word_timestamps, " +
      "Deepgram JSON, or a plain [{word, start, end}] array in seconds, or start_ms/end_ms). Same styles as reflow_captions; reels style is the classic " +
      "word-by-word social caption.",
    inputSchema: {
      words_path: z.string().optional().describe("Path to the JSON file with word timings."),
      words_json: z.string().optional().describe("The JSON itself, if no file."),
      ...reflowSchema,
      output_format: formatEnum.default("srt"),
      ass_style: assStyleSchema,
      ...output,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      if (!a.words_path && !a.words_json) throw new Error("Provide words_path or words_json.");
      const raw = a.words_path ? (await readText(a.words_path)).text : a.words_json!;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error("Word timestamps must be valid JSON.");
      }
      const words = parseWordTimestamps(json);
      const o = reflowOptions(a);
      const cues = reflowWords(words, o);
      const assStyle = resolveAssStyle(a.ass_style ?? (a.style === "reels" ? { preset: "vertical_reel" } : undefined));
      return respond(`Built captions from ${words.length} timed words.`, cues, {
        to: a.output_format,
        fallback: "srt",
        output_path: a.output_path,
        overwrite: a.overwrite,
        assStyle,
      });
    }),
);

server.registerTool(
  "clip_captions",
  {
    title: "Cut captions for a clip",
    description:
      "Keep only the captions inside a time range and re-zero them to start at 00:00 — for when you cut a short clip out of a long video or podcast. " +
      "Cues crossing the edges are trimmed to the range.",
    inputSchema: {
      ...input,
      start: z.string().describe('Clip start in the source, e.g. "00:12:03.5" or "723.5s".'),
      end: z.string().describe("Clip end in the source."),
      rezero: z.boolean().default(true).describe("Shift so the clip starts at 00:00:00."),
      output_format: toFormat,
      ...output,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const s = parseOffset(a.start);
      const e = parseOffset(a.end);
      if (e <= s) throw new Error("end must be after start.");
      const off = a.rezero ? s : 0;
      const cues = p.cues
        .filter((c) => c.end > s && c.start < e)
        .map((c) => ({ ...c, start: Math.max(c.start, s) - off, end: Math.min(c.end, e) - off }))
        .filter((c) => c.end - c.start >= 50);
      if (!cues.length) throw new Error(`No captions between ${fmtVtt(s)} and ${fmtVtt(e)}.`);
      return respond(`Clipped ${p.source} to ${fmtVtt(s)}–${fmtVtt(e)}${a.rezero ? " (re-zeroed)" : ""}.`, cues, { to: a.output_format, fallback: p.format, output_path: a.output_path, overwrite: a.overwrite, inputFile: p.file });
    }),
);

server.registerTool(
  "search_captions",
  {
    title: "Search captions",
    description:
      "Find where something is said: returns every matching cue with its timestamp, optionally with surrounding lines. " +
      "Great for finding soundbites or a quote in a long interview, podcast or talk.",
    inputSchema: {
      ...input,
      query: z.string().min(1),
      regex: z.boolean().default(false).describe("Treat query as a regular expression."),
      whole_word: z.boolean().default(false),
      context: z.number().int().min(0).max(5).default(1).describe("Neighboring cues to include on each side."),
      max_results: z.number().int().min(1).max(500).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const hits = search(p.cues, a.query, { regex: a.regex, wholeWord: a.whole_word, context: a.context });
      const shown = hits.slice(0, a.max_results);
      if (!hits.length) return ok(`No matches for "${a.query}" in ${p.source}.`, { matches: 0 });
      const lines = shown.map((h) => `- **${h.start.slice(0, 12)}** (cue ${h.cue}): ${h.context_before ? `…${h.context_before.slice(-80)} ` : ""}**${h.text}**${h.context_after ? ` ${h.context_after.slice(0, 80)}…` : ""}`);
      return ok(`${hits.length} match(es) for "${a.query}" in ${p.source}:\n${lines.join("\n")}${hits.length > shown.length ? `\n(${hits.length - shown.length} more)` : ""}`, { matches: hits.length, hits: shown });
    }),
);

server.registerTool(
  "extract_transcript",
  {
    title: "Extract a clean transcript",
    description:
      "Turn captions into a readable transcript: tags stripped, rolling duplicate lines from auto-generated captions removed, paragraphs split on pauses, " +
      "optional [HH:MM:SS] timestamps per paragraph and speaker-label removal. Useful for show notes, blog posts, chapter markers or feeding the text to an LLM.",
    inputSchema: {
      ...input,
      timestamps: z.boolean().default(false),
      paragraph_gap_ms: z.number().int().min(0).max(60000).default(2000).describe("Start a new paragraph after a pause this long."),
      strip_speaker_tags: z.boolean().default(false),
      output_path: output.output_path,
      overwrite: output.overwrite,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async (a) =>
    guard(async () => {
      const p = await loadCaptions(a);
      const t = transcript(p.cues, { timestamps: a.timestamps, paragraphGapMs: a.paragraph_gap_ms, stripSpeakerTags: a.strip_speaker_tags });
      const words = t.text.split(/\s+/).filter(Boolean).length;
      if (a.output_path) {
        const out = await writeOutput(t.text + "\n", a.output_path, a.overwrite, p.file);
        return ok(`Transcript of ${p.source}: ${t.paragraphs.length} paragraph(s), ${words} words. Saved to ${out}`, { output: out, paragraphs: t.paragraphs.length, words });
      }
      return ok(`Transcript of ${p.source}: ${t.paragraphs.length} paragraph(s), ${words} words.\n\n${t.text}`);
    }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[caption-forge-mcp] v${VERSION} ready on stdio`);
}

main().catch((e) => {
  console.error("[caption-forge-mcp] fatal:", e);
  process.exit(1);
});

