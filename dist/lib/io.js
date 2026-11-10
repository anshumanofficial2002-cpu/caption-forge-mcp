/** Reading caption input (file or inline text) and writing output safely. */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCaptions, serialize } from "./captions.js";
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export function expandPath(p) {
    let out = p.trim();
    if (out === "~")
        out = os.homedir();
    else if (out.startsWith("~/") || out.startsWith("~\\"))
        out = path.join(os.homedir(), out.slice(2));
    return path.resolve(out);
}
export async function readText(p) {
    const file = expandPath(p);
    let s;
    try {
        s = await stat(file);
    }
    catch {
        throw new Error(`File not found: ${file}`);
    }
    if (!s.isFile())
        throw new Error(`Not a file: ${file}`);
    if (s.size > MAX_INPUT_BYTES)
        throw new Error(`File is larger than 20 MB: ${file}`);
    const buf = await readFile(file);
    // UTF-16 BOMs show up in subtitles exported from some Windows tools
    if (buf[0] === 0xff && buf[1] === 0xfe)
        return { file, text: buf.toString("utf16le").replace(/^\uFEFF/, "") };
    if (buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.from(buf);
        swapped.swap16();
        return { file, text: swapped.toString("utf16le").replace(/^\uFEFF/, "") };
    }
    return { file, text: buf.toString("utf8") };
}
export async function loadCaptions(a) {
    if (!a.path && !a.content)
        throw new Error("Provide either path (a caption file) or content (the caption text).");
    if (a.path) {
        const { file, text } = await readText(a.path);
        return { ...parseCaptions(text, a.format, file), source: path.basename(file), file };
    }
    return { ...parseCaptions(a.content, a.format), source: "inline content" };
}
export async function writeOutput(text, outputPath, overwrite, inputFile) {
    const abs = expandPath(outputPath);
    if (inputFile && path.resolve(inputFile) === abs && !overwrite) {
        throw new Error("Output path is the input file. Pass overwrite: true to replace it in place.");
    }
    let exists = false;
    try {
        await stat(abs);
        exists = true;
    }
    catch {
        /* new file */
    }
    if (exists && !overwrite)
        throw new Error(`Output already exists: ${abs}. Pass overwrite: true to replace it.`);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text, "utf8");
    return abs;
}
export function formatFromPath(p) {
    const ext = p?.split(".").pop()?.toLowerCase();
    if (ext === "srt" || ext === "vtt" || ext === "json" || ext === "txt")
        return ext;
    if (ext === "ass" || ext === "ssa")
        return "ass";
    return undefined;
}
/** Serialize and either write to output_path or return inline. */
export async function emit(cues, opts) {
    const format = opts.to ?? formatFromPath(opts.output_path) ?? opts.fallback;
    const text = serialize(cues, format, opts.assStyle);
    if (opts.output_path) {
        const written = await writeOutput(text, opts.output_path, opts.overwrite ?? false, opts.inputFile);
        return { text, format, written };
    }
    return { text, format };
}
export function inlineBlock(text, format, maxChars = 60000) {
    const lang = format === "json" ? "json" : format === "txt" ? "text" : format;
    if (text.length <= maxChars)
        return "```" + lang + "\n" + text + "\n```";
    return "```" + lang + "\n" + text.slice(0, maxChars) + "\n```\n(Output truncated — pass output_path to save the full file.)";
}
