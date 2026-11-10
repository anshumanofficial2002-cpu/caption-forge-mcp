# caption-forge-mcp

[![CI](https://github.com/anshumanofficial2002-cpu/caption-forge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anshumanofficial2002-cpu/caption-forge-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black)](https://modelcontextprotocol.io)

**Subtitles that your AI assistant can actually fix.**

`caption-forge-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server for working with captions: convert SRT ⇄ VTT ⇄ ASS, fix sync drift, lint for readability, and turn long subtitle lines or raw speech-to-text word timings into the short, punchy captions you see on Reels, TikTok and Shorts.

Pure TypeScript. No ffmpeg, no API keys, no network. Works on any caption file you point it at — or on caption text pasted straight into the chat.

```
You:    My podcast SRT is 1.2 seconds late and the lines are huge. Make reel captions,
        all caps, and give me an ASS file I can burn into the vertical cut.
Claude: Shifted -1200 ms, then reflowed 214 cues → 611 three-word captions.
        Saved ep42_reels.ass (1080x1920, bold, above the UI zone). Burn in with:
        ffmpeg -i ep42_vertical.mp4 -vf "subtitles='ep42_reels.ass'" -c:a copy out.mp4
```

---

## Tools

| Tool | What it does |
| --- | --- |
| `caption_info` | Format, cue count, time span, words and speaking rate, reading speed (CPS), longest line, lines per cue, tags, parse warnings, preview. |
| `convert_captions` | SRT ⇄ WebVTT ⇄ ASS ⇄ JSON → plain text. Styled ASS output (presets or custom font/size/color/outline/box/position) plus an ffmpeg burn-in command. |
| `shift_captions` | Move all cues (or only cues after a point, e.g. after a cut) earlier or later. |
| `retime_captions` | Fix drift: frame-rate conversion (23.976 → 25 etc.), stretch factor, or **two-point sync** (tell it the right time for an early and a late line). |
| `lint_captions` | Readability check with cue numbers and timestamps: line length, line count, reading speed, min/max duration, overlaps, order, flicker gaps, empty cues. |
| `clean_captions` | Auto-fix: whitespace, empty cues, sorting, duplicate merging, overlaps, gaps, too-short cues. Optional removal of `[MUSIC]`, `(laughs)`, `♪`, `SPEAKER:` labels. |
| `reflow_captions` | Re-chunk existing cues: **reels** (1–3 words, one short line, optional ALL CAPS) or **standard** (balanced ≤42-char lines, max 2). Breaks on sentence/phrase boundaries. |
| `captions_from_words` | Frame-accurate captions from word timestamps (Whisper, faster-whisper, WhisperX, Deepgram, or a plain `[{word,start,end}]` array). |
| `clip_captions` | Keep only a time range and re-zero it — for clips cut from a long video or podcast. |
| `search_captions` | Find where something is said, with timestamps and surrounding lines. |
| `extract_transcript` | Clean transcript: tags stripped, rolling duplicates from auto-captions removed, paragraphs on pauses, optional timestamps. |

Every tool accepts **either** `path` (a local file) **or** `content` (the caption text). Results come back inline unless you pass `output_path`.

### Formats

| Format | Read | Write | Notes |
| --- | --- | --- | --- |
| SRT | ✅ | ✅ | BOM, CRLF, missing indexes and UTF-16 files handled. |
| WebVTT | ✅ | ✅ | Cue settings, identifiers, `NOTE`/`STYLE` blocks and YouTube karaoke tags handled. |
| ASS / SSA | ✅ | ✅ | Reads any `Format:` column order. Writes one styled `Default` style. |
| JSON | ✅ | ✅ | `[{start, end, text}]` in seconds, `start_ms/end_ms`, or timestamp strings. |
| Plain text | — | ✅ | Transcript. |

---

## Requirements

- **Node.js 20+**. That's it.

## Install

Runs straight from GitHub with `npx` — nothing to publish or build.

### Claude Desktop

**Settings → Developer → Edit Config**:

```json
{
  "mcpServers": {
    "caption-forge": {
      "command": "npx",
      "args": ["-y", "github:anshumanofficial2002-cpu/caption-forge-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```sh
claude mcp add caption-forge -- npx -y github:anshumanofficial2002-cpu/caption-forge-mcp
```

### Cursor / Windsurf / VS Code / other clients

```json
{
  "caption-forge": {
    "command": "npx",
    "args": ["-y", "github:anshumanofficial2002-cpu/caption-forge-mcp"]
  }
}
```

### From source

```sh
git clone https://github.com/anshumanofficial2002-cpu/caption-forge-mcp.git
cd caption-forge-mcp && npm install && npm run build
# point your client at: node /absolute/path/to/caption-forge-mcp/dist/index.js
```

---

## Example prompts

- "What's wrong with `~/Downloads/interview.srt`? Lint it with the standard streaming rules."
- "These captions start in sync but are 3 seconds late by the end. Line 1 should be at 00:00:02,100 and the last line at 00:41:55,300."
- "Convert `episode.vtt` to SRT and remove the [MUSIC] tags."
- "Make TikTok-style captions from `whisper_words.json`, two words at a time, uppercase, as an ASS file for a vertical video."
- "I clipped 12:03 to 12:58 from the podcast. Give me captions for just that clip."
- "Find every time the guest says 'compounding' in `ep12.srt`."
- "Turn this SRT into a clean transcript with timestamps every paragraph, I need show notes." *(paste the SRT)*

---

## Tool reference

Common input params for every caption tool:

| Param | Type | Notes |
| --- | --- | --- |
| `path` | string | Local `.srt`, `.vtt`, `.ass/.ssa` or `.json`. `~` expanded. Max 20 MB. |
| `content` | string | Caption text instead of a file. |
| `format` | `srt` \| `vtt` \| `ass` \| `json` | Force input format (auto-detected otherwise). |
| `output_path` | string | Write to this file. Format follows the extension unless set explicitly. |
| `output_format` | `srt` \| `vtt` \| `ass` \| `json` \| `txt` | Output format (defaults to input format). `convert_captions` uses `to` instead. |
| `overwrite` | boolean | Default `false`. Existing files are never replaced without it. |

### `convert_captions`
`to` (required), `ass_style`:

| `ass_style` field | Meaning |
| --- | --- |
| `preset` | `vertical_reel` (1080x1920, 84 px bold, raised above the app UI), `horizontal` (1920x1080 bottom), `lower_third` |
| `font`, `font_size` | Font family and size in pixels of the play resolution |
| `primary_color`, `outline_color` | `#RRGGBB` |
| `outline`, `shadow` | Thickness in pixels |
| `bold` | boolean |
| `alignment` | Numpad position: 2 bottom-center, 5 middle, 8 top |
| `margin_v` | Distance from the aligned edge |
| `box` | Opaque box behind text instead of an outline |

### `shift_captions`
`offset` — ms number or `"2.5s"`, `"-1500ms"`, `"-00:00:01,200"`. `from` — only shift cues at/after this time.

### `retime_captions`
`mode`: `fps` (`from_fps`, `to_fps`), `factor` (`factor`), or `sync_points` (`first_original`, `first_correct`, `second_original`, `second_correct`).

### `lint_captions`

| Preset | Chars/line | Lines | Max CPS | Min/Max duration | Min gap |
| --- | --- | --- | --- | --- | --- |
| `standard` | 42 | 2 | 17 | 0.833 s / 7 s | 83 ms |
| `reels` | 24 | 1 | 22 | 0.3 s / 3 s | 0 |
| `accessible` | 37 | 2 | 13 | 1.5 s / 7 s | 83 ms |

Override any rule: `max_chars_per_line`, `max_lines`, `max_cps`, `min_duration_ms`, `max_duration_ms`, `min_gap_ms`. Limit output with `max_issues`.

### `clean_captions`
`min_gap_ms` (83), `min_duration_ms` (833), `merge_duplicates` (true), `remove_hearing_impaired` (false).

### `reflow_captions` / `captions_from_words`

| Param | reels default | standard default |
| --- | --- | --- |
| `style` | `reels` | `standard` (or `custom`) |
| `max_words` | 3 | 40 |
| `max_chars_per_line` | 22 | 42 |
| `max_lines` | 1 | 2 |
| `uppercase` | false | false |
| `strip_punctuation` | true | false |
| `min_duration_ms` | 250 | 833 |

`reflow_captions` estimates word timing inside each original cue from word length. For exact timing, use `captions_from_words` with `words_path` or `words_json`. Accepted shapes:

```jsonc
[{ "word": "Hey", "start": 0.0, "end": 0.3 }]                 // seconds
[{ "text": "Hey", "start_ms": 0, "end_ms": 300 }]             // milliseconds
{ "segments": [{ "words": [{ "word": " Hey", "start": 0.0, "end": 0.3 }] }] }   // Whisper
{ "results": { "channels": [{ "alternatives": [{ "words": [...] }] }] } }        // Deepgram
```

### `clip_captions`
`start`, `end` (source times), `rezero` (true).

### `search_captions`
`query`, `regex` (false), `whole_word` (false), `context` (1), `max_results` (50).

### `extract_transcript`
`timestamps` (false), `paragraph_gap_ms` (2000), `strip_speaker_tags` (false), `output_path`.

---

## Notes

- ASS input loses its original styles when written back out; text and timing are kept.
- Reading speed (CPS) counts every visible character including spaces, the usual convention for subtitle guidelines.
- Overwrites are refused unless `overwrite: true`, and writing over the input file needs it explicitly.

## Development

```sh
npm install
npm run build
npm test          # parser/ops unit tests + end-to-end tests over stdio
npm run inspect   # MCP Inspector
```

`dist/` is committed so `npx github:…` works without a build; CI verifies it matches `src/`.

## Related servers

- [video-probe-mcp](https://github.com/anshumanofficial2002-cpu/video-probe-mcp) — inspect and conform video for each platform
- [caption-forge-mcp](https://github.com/anshumanofficial2002-cpu/caption-forge-mcp) — SRT/VTT/ASS conversion, timing, linting and reel-style captions
- [loudness-check-mcp](https://github.com/anshumanofficial2002-cpu/loudness-check-mcp) — LUFS, true peak, normalization, silence and clipping
- [frame-grab-mcp](https://github.com/anshumanofficial2002-cpu/frame-grab-mcp) — frames, contact sheets, scene cuts and thumbnails your AI can see
- [script-timer-mcp](https://github.com/anshumanofficial2002-cpu/script-timer-mcp) — time, trim and format scripts for short-form video

## License

[MIT](LICENSE) © 2026 Anshuman
