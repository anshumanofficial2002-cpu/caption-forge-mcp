# Changelog

## 1.0.0 — 2026-11-11

First release.

- Read/write SRT, WebVTT, ASS/SSA, JSON; write plain-text transcripts
- `caption_info`, `convert_captions` (styled ASS + burn-in command), `shift_captions`, `retime_captions` (fps, factor, two-point sync)
- `lint_captions` with standard / reels / accessible presets, `clean_captions`
- `reflow_captions` and `captions_from_words` (Whisper, Deepgram, plain arrays) for reel-style captions
- `clip_captions`, `search_captions`, `extract_transcript`
