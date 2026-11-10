import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connect, jsonOf, textOf, TMP } from "./helpers.mjs";

let client;
const srt = path.join(TMP, "talk.srt");

before(async () => {
  writeFileSync(srt, `1
00:00:01,000 --> 00:00:04,000
Most people think editing is about cutting.

2
00:00:04,100 --> 00:00:08,000
It's actually about deciding what the audience never needs to see.
`);
  client = await connect();
});
after(async () => client?.close());

test("lists all tools with descriptions", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "caption_info", "captions_from_words", "clean_captions", "clip_captions", "convert_captions", "extract_transcript",
    "lint_captions", "reflow_captions", "retime_captions", "search_captions", "shift_captions",
  ]);
  for (const t of tools) assert.ok(t.description.length > 60, t.name);
});

test("caption_info reads a file", async () => {
  const res = await client.callTool({ name: "caption_info", arguments: { path: srt } });
  const d = jsonOf(res);
  assert.equal(d.format, "srt");
  assert.equal(d.cues, 2);
});

test("convert to VTT inline and to ASS on disk", async () => {
  const inline = await client.callTool({ name: "convert_captions", arguments: { path: srt, to: "vtt" } });
  assert.match(textOf(inline), /WEBVTT/);
  const out = path.join(TMP, "talk.ass");
  rmSync(out, { force: true });
  const res = await client.callTool({ name: "convert_captions", arguments: { path: srt, to: "ass", ass_style: { preset: "vertical_reel", primary_color: "#FFE600" } , output_path: out } });
  assert.ok(!res.isError, textOf(res));
  const ass = readFileSync(out, "utf8");
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /&H0000E6FF/);
  assert.match(textOf(res), /ffmpeg -i input.mp4/);
  const again = await client.callTool({ name: "convert_captions", arguments: { path: srt, to: "ass", output_path: out } });
  assert.equal(again.isError, true, "refuses to overwrite");
});

test("shift accepts inline content", async () => {
  const res = await client.callTool({ name: "shift_captions", arguments: { content: readFileSync(srt, "utf8"), offset: "-0.5s" } });
  assert.match(textOf(res), /00:00:00,500 --> 00:00:03,500/);
});

test("lint and reflow", async () => {
  const lintRes = await client.callTool({ name: "lint_captions", arguments: { path: srt, preset: "standard" } });
  assert.ok(jsonOf(lintRes).by_rule.line_too_long >= 1);
  const out = path.join(TMP, "talk_reels.srt");
  rmSync(out, { force: true });
  const rf = await client.callTool({ name: "reflow_captions", arguments: { path: srt, style: "reels", uppercase: true, output_path: out } });
  assert.ok(!rf.isError, textOf(rf));
  assert.ok(existsSync(out));
  const after = await client.callTool({ name: "lint_captions", arguments: { path: out, preset: "reels" } });
  assert.equal(jsonOf(after).by_rule.line_too_long ?? 0, 0);
});

test("clip, search, transcript, words", async () => {
  const clip = await client.callTool({ name: "clip_captions", arguments: { path: srt, start: "4s", end: "8s" } });
  assert.match(textOf(clip), /00:00:00,100 --> 00:00:04,000/);
  const s = await client.callTool({ name: "search_captions", arguments: { path: srt, query: "audience" } });
  assert.equal(jsonOf(s).matches, 1);
  const t = await client.callTool({ name: "extract_transcript", arguments: { path: srt } });
  assert.match(textOf(t), /Most people think editing is about cutting\. It's actually/);
  const w = await client.callTool({ name: "captions_from_words", arguments: { words_json: JSON.stringify([{ word: "Stop", start: 0, end: 0.4 }, { word: "scrolling.", start: 0.4, end: 1 }]) } });
  assert.match(textOf(w), /00:00:00,000 --> 00:00:01,000\nStop scrolling/);
});

test("bad input is a tool error, not a crash", async () => {
  const res = await client.callTool({ name: "caption_info", arguments: { content: "not captions at all" } });
  assert.equal(res.isError, true);
});
