// The tab (a mod pane) that shows one file: props {path, on, line?}. Text in Herdr's read-only
// editor with syntax colors (as the Files panel shows previews), markdown rendered
// (or its source), images fitted to the pane. Images on another machine are copied
// into data/open-file/ first and dropped when the pane closes. The file is re-read
// when it changes: a folder watch here, a stat every ten seconds there.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, theme, settings, exec, readTextFile, watchFolder, appHome, home, placement } from "herdr";
import * as fs from "fs/promises";
import { STAT, sh, basename, dirname, ext, language, IMAGE, isMarkdown, imageSize, svgSize, bytes, shorten } from "./paths.js";

const TEXT_MAX = 400000, READ_MAX = 2000000, IMAGE_MAX = 50000000, POLL = 10000;
const hash = (s) => { let h = 5381; for (const c of s) h = ((h * 33) ^ c.codePointAt(0)) >>> 0; return h.toString(16); };

export default class Show {
  init(cx) {
    const p = props();
    this.path = p.path; this.on = p.on ?? null; this.line = p.line ?? null;
    this.kind = IMAGE.has(ext(this.path)) ? "image" : "text";
    this.state = "loading"; this.stamp = null; this.error = null; this.size = 0;
    this.code = null; this.text = null; this.image = null; this.copy = null;
    this.source = false; this.box = null; this.busy = false;
    this.load(cx);
    if (this.on) cx.timer.every(POLL, (cx) => this.check(cx));
    else cx.spawn(async (cx) => {
      // The watch covers the folder; a change there is a cheap stat here.
      try { for (;;) { await watchFolder(dirname(this.path)); this.check(cx); } }
      catch { cx.timer.every(POLL, (cx) => this.check(cx)); }
    });
  }

  async stat() {
    const r = await sh(STAT, [this.path], this.on);
    const m = /^(\d+) (\d+)/.exec(r.stdout.trim());
    return m ? { size: +m[1], mtime: +m[2] } : null;
  }

  check(cx) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      const s = await this.stat().catch(() => null);
      const stamp = s ? `${s.size}:${s.mtime}` : null;
      if (stamp !== this.stamp) await this.reload(cx);
    });
  }

  load(cx) { cx.spawn((cx) => this.reload(cx)); }

  async reload(cx) {
    if (this.busy) return;
    this.busy = true;
    try { await this.read(); }
    catch (e) { this.state = "error"; this.error = String(e?.message ?? e); }
    finally { this.busy = false; cx.notify(); }
  }

  async read() {
    const s = await this.stat();
    if (!s) { this.state = "missing"; this.stamp = null; return; }
    const stamp = `${s.size}:${s.mtime}`;
    if (stamp === this.stamp && this.state === "ready") return;
    this.size = s.size;
    if (this.kind === "image") await this.readImage(s);
    else await this.readText(s);
    this.stamp = stamp; this.state = "ready"; this.error = null;
  }

  async readImage(s) {
    if (s.size > IMAGE_MAX) throw new Error(`Image too large to show (${bytes(s.size)})`);
    const dir = `${appHome()}/data/open-file`, name = `${hash(`${this.on ?? ""}:${this.path}`)}-${s.mtime}.${ext(this.path)}`;
    const local = `${dir}/${name}`;
    const r = this.on
      ? await exec("sh", ["-c", 'mkdir -p -- "$1" && { command -v hc >/dev/null 2>&1 || PATH="$HOME/.local/bin:$PATH"; } && hc exec --on "$2" -- cat "$3" > "$4"', "open-file", dir, this.on, this.path, local])
      : await exec("sh", ["-c", 'mkdir -p -- "$1" && cat -- "$2" > "$3"', "open-file", dir, this.path, local]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this image");
    let dims = null;
    try { dims = ext(this.path) === "svg" ? svgSize(await fs.readFile(local, "utf8")) : imageSize(await fs.readFile(local)); } catch {}
    if (!dims) {
      // The header said nothing (macOS): ask the system.
      const q = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", local]).catch(() => null);
      const w = /pixelWidth: (\d+)/.exec(q?.stdout ?? "")?.[1], h = /pixelHeight: (\d+)/.exec(q?.stdout ?? "")?.[1];
      if (w && h) dims = { width: +w, height: +h };
    }
    if (this.copy && this.copy !== local) fs.unlink(this.copy).catch(() => {});
    this.copy = local;
    this.image = { src: `data/open-file/${name}`, vector: ext(this.path) === "svg", ...(dims ?? {}) };
  }

  async readText(s) {
    let text;
    if (s.size > READ_MAX) {
      const r = await exec("head", ["-c", String(TEXT_MAX), "--", this.path], { on: this.on });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this file");
      text = r.stdout + "\n… (file truncated)";
    } else {
      text = await readTextFile(this.path, { on: this.on });
      if (text === null) throw new Error("Cannot read this file");
    }
    if (text.includes("\0")) { this.state = "binary"; this.text = null; return; }
    if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX) + "\n… (file truncated)";
    this.text = text;
    this.code?.release();
    const t = theme();
    this.code = EditorState.new({ language: language(this.path), readonly: true, value: text,
      font_family: settings().font_family, font_size: settings().font_size || 13,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  async cleanup() {
    this.code?.release();
    if (this.copy) await fs.unlink(this.copy).catch(() => {});
  }

  button(t, id, label, active, action) {
    return div().id(id).px(8).h(22).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label);
  }

  picture(t) {
    const img = this.image, pad = 16, zoom = settings().zoom || 1;
    const bw = (this.box?.width ?? 0) / zoom - pad * 2, bh = (this.box?.height ?? 0) / zoom - pad * 2;
    let shown = null;
    if (img && bw > 0 && bh > 0) {
      const iw = img.width || bw, ih = img.height || bh;
      let scale = Math.min(bw / iw, bh / ih);
      if (img.width && !img.vector) scale = Math.min(scale, 1);
      shown = image(img.src).w(Math.max(1, Math.floor(iw * scale))).h(Math.max(1, Math.floor(ih * scale))).flex_none();
    }
    return div().id("open-file-picture").flex_1().min_h(0).overflow_hidden().bg(t.canvas).flex().items_center().justify_center()
      .on_size_change((size, cx) => { this.box = size; cx.notify(); })
      .when(Boolean(shown), (el) => el.child(shown));
  }

  body(t) {
    const note = (text) => div().p(16).text_size(12.5).text_color(t.dim).child(text);
    if (this.state === "loading") return note("Loading…");
    if (this.state === "missing") return note(`File not found: ${this.path}`);
    if (this.state === "error") return note(this.error ?? "Cannot show this file");
    if (this.state === "binary") return note(`Binary file · ${bytes(this.size)} · no preview`);
    if (this.kind === "image") return this.picture(t);
    if (isMarkdown(this.path) && !this.source && this.text !== null)
      return v_flex().id("open-file-md").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14)
        .child(TextView.markdown(`open-file-md-${hash(this.path)}`, this.text).selectable(true));
    return this.code ? Editor.new(this.code).flex_1().min_h(0) : note("Loading…");
  }

  render() {
    const t = theme();
    const name = basename(this.path), where = shorten(dirname(this.path), this.on ? null : home());
    const md = isMarkdown(this.path), img = this.image;
    const meta = this.kind === "image" && img?.width ? `${img.width} × ${img.height} · ${bytes(this.size)}` : this.state === "ready" ? bytes(this.size) : "";
    // A pane fills it; a floating copy (over a layout) has no size of its own, so it takes one.
    const floating = placement() !== null;
    return v_flex().id("open-file-view").when(floating, (el) => el.w(560).h(400)).when(!floating, (el) => el.size_full()).min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(svg(`mods/open-file/${this.kind === "image" ? "image" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().truncate().max_w(300).font_medium().child(name))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(where))
        .when(Boolean(this.on), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(10.5).text_color(t.muted).child(this.on)))
        .when(Boolean(this.line), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`line ${this.line}`)))
        .when(Boolean(meta), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(meta)))
        .when(md && this.state === "ready", (el) => el
          .child(this.button(t, "open-file-rendered", "Rendered", !this.source, (cx) => { this.source = false; cx.notify(); }))
          .child(this.button(t, "open-file-source", "Source", this.source, (cx) => { this.source = true; cx.notify(); })))
        .child(this.button(t, "open-file-reload", "↻", false, (cx) => { this.stamp = null; this.load(cx); })))
      .child(this.body(t));
  }
}
