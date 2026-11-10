import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat, parseCaptions, toSrt, toVtt, toAss, parseAss, parseOffset, transcript, cps } from "../dist/lib/captions.js";
import { shift, twoPointSync, linearRetime, lint, LINT_PRESETS, clean, reflow, balanceLines, parseWordTimestamps, reflowWords, search, stats } from "../dist/lib/ops.js";

const SRT = `\uFEFF1
00:00:01,000 --> 00:00:03,500
Hello there, and welcome
to the show.

2
00:00:03,600 --> 00:00:05,000
<i>Today we test captions.</i>

3
00:00:05,000 --> 00:00:09,000
This line is far too long to fit comfortably on a single caption line at all
`;

const VTT = `WEBVTT
Kind: captions

NOTE a comment

intro
00:01.000 --> 00:03.500 align:start position:0%
Hello there<00:00:02.000><c> again</c>

00:00:03.600 --> 00:00:05.000
Second cue
`;

test("detects formats", () => {
  assert.equal(detectFormat(SRT), "srt");
  assert.equal(detectFormat(VTT), "vtt");
  assert.equal(detectFormat("[Script Info]\nTitle: x"), "ass");
  assert.equal(detectFormat('[{"start":1,"end":2,"text":"a"}]'), "json");
});

test("parses SRT with BOM, tags and multi-line cues", () => {
  const { cues } = parseCaptions(SRT);
  assert.equal(cues.length, 3);
  assert.deepEqual([cues[0].start, cues[0].end], [1000, 3500]);
  assert.equal(cues[0].text, "Hello there, and welcome\nto the show.");
});

test("parses VTT with settings, identifiers and karaoke tags", () => {
  const { cues } = parseCaptions(VTT);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1000);
  assert.equal(cues[0].text, "Hello there again");
});

test("round-trips SRT → VTT → ASS → SRT", () => {
  const { cues } = parseCaptions(SRT);
  const vtt = parseCaptions(toVtt(cues)).cues;
  const ass = parseAss(toAss(vtt)).cues;
  assert.equal(ass.length, 3);
  assert.equal(ass[0].text, cues[0].text);
  assert.equal(ass[0].start, 1000);
  assert.match(toSrt(ass), /^1\n00:00:01,000 --> 00:00:03,500\n/);
});

test("parseOffset understands many spellings", () => {
  assert.equal(parseOffset(250), 250);
  assert.equal(parseOffset("2.5s"), 2500);
  assert.equal(parseOffset("-1500ms"), -1500);
  assert.equal(parseOffset("-00:00:01,200"), -1200);
  assert.equal(parseOffset("1:00"), 60000);
});

test("shift moves later cues and drops ones pushed before zero", () => {
  const { cues } = parseCaptions(SRT);
  const r = shift(cues, -3550);
  assert.equal(r.dropped, 1);
  assert.equal(r.cues[0].start, 50);
  const partial = shift(cues, 1000, 3600);
  assert.equal(partial.cues[0].start, 1000);
  assert.equal(partial.cues[1].start, 4600);
});

test("two-point sync maps both anchors exactly", () => {
  const { cues } = parseCaptions(SRT);
  const r = twoPointSync(cues, 1000, 2000, 5000, 7000);
  assert.equal(r.cues[0].start, 2000);
  assert.equal(r.cues[2].start, 7000);
});

test("fps retime 23.976 → 25 shortens times", () => {
  const out = linearRetime([{ start: 100000, end: 101000, text: "x" }], (24000 / 1001) / 25);
  assert.equal(out[0].start, 95904);
});

test("lint flags long lines, fast reading and overlaps", () => {
  const cues = [
    { start: 0, end: 500, text: "This is a very long line that definitely exceeds the limit" },
    { start: 400, end: 2000, text: "ok" },
  ];
  const rules = new Set(lint(cues, LINT_PRESETS.standard).map((i) => i.rule));
  for (const r of ["line_too_long", "reading_speed", "too_short", "overlap"]) assert.ok(rules.has(r), r);
});

test("clean fixes overlaps, merges duplicates and strips SDH", () => {
  const cues = [
    { start: 2000, end: 3000, text: "[MUSIC] Second" },
    { start: 0, end: 2100, text: "  JOHN:   First  " },
    { start: 3000, end: 3100, text: "" },
    { start: 3100, end: 4000, text: "[MUSIC] Second" },
  ];
  const r = clean(cues, { min_gap_ms: 83, min_duration_ms: 833, merge_duplicates: true, remove_hearing_impaired: true });
  assert.equal(r.cues[0].text, "First");
  assert.equal(r.cues[0].end, 2000 - 83);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[1].text, "Second");
  assert.equal(r.cues[1].end, 4000);
});

test("balanceLines splits near the middle and prefers punctuation", () => {
  assert.equal(balanceLines("one two three four five six seven eight nine ten eleven twelve", 42, 2), "one two three four five six seven\neight nine ten eleven twelve");
  assert.equal(balanceLines("We tried everything, and nothing worked until we did this", 42, 2), "We tried everything,\nand nothing worked until we did this");
  assert.equal(balanceLines("short", 42, 2), "short");
});

test("reflow reels style makes short cues inside the original span", () => {
  const { cues } = parseCaptions(SRT);
  const out = reflow(cues, { max_words: 3, max_chars_per_line: 22, max_lines: 1, uppercase: true, strip_punctuation: true, min_duration_ms: 200 });
  assert.ok(out.length > cues.length * 2);
  assert.ok(out.every((c) => c.text.split(/\s+/).length <= 3 && !c.text.includes("\n")));
  assert.equal(out[0].text, "HELLO THERE");
  assert.equal(out[0].start, 1000);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].end - 1, "no overlaps");
});

test("parses Whisper and plain word timestamps", () => {
  const whisper = { segments: [{ words: [{ word: " Hey", start: 0.0, end: 0.3 }, { word: " everyone.", start: 0.3, end: 0.9 }] }, { words: [{ word: " Today", start: 1.2, end: 1.5 }] }] };
  const w = parseWordTimestamps(whisper);
  assert.equal(w.length, 3);
  assert.deepEqual(w[1], { text: "everyone.", start: 300, end: 900 });
  const cues = reflowWords(w, { max_words: 3, max_chars_per_line: 22, max_lines: 1, uppercase: false, strip_punctuation: false, min_duration_ms: 0 });
  assert.equal(cues.length, 2, "sentence end forces a break");
  assert.equal(cues[0].text, "Hey everyone.");
  assert.deepEqual(parseWordTimestamps([{ word: "a", start_ms: 10, end_ms: 20 }])[0], { text: "a", start: 10, end: 20 });
  assert.throws(() => parseWordTimestamps({ nope: true }));
});

test("search finds words with context", () => {
  const { cues } = parseCaptions(SRT);
  const hits = search(cues, "captions", { regex: false, wholeWord: true, context: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].cue, 2);
  assert.match(hits[0].context_before, /welcome/);
});

test("transcript removes rolling duplicates and splits paragraphs", () => {
  const cues = [
    { start: 0, end: 1000, text: "first line" },
    { start: 1000, end: 2000, text: "first line\nsecond line" },
    { start: 6000, end: 7000, text: "after a pause" },
  ];
  const t = transcript(cues, { paragraphGapMs: 2000, timestamps: true });
  assert.equal(t.paragraphs.length, 2);
  assert.equal(t.paragraphs[0].text, "first line second line");
  assert.match(t.text, /^\[00:00:00\] first line/);
});

test("stats and cps", () => {
  assert.equal(Math.round(cps({ start: 0, end: 1000, text: "abcdefghij" })), 10);
  const s = stats(parseCaptions(SRT).cues);
  assert.equal(s.cues, 3);
  assert.ok(s.longest_line_chars > 60);
});
