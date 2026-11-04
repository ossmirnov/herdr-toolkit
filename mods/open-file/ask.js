// The Cmd-P popup: a path, relative to the focused terminal's folder on its machine or
// absolute (~ is that machine's home). As you type, the folder's entries that match
// are listed; ↑/↓ pick, Tab completes (a folder gets its "/"), Enter opens the picked
// entry (a folder: steps into it), Esc leaves. Empty, it lists recent files first.
// A path ending in :line opens the file and shows the line in the pane's header.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, shared, setShared, home } from "herdr";
import { location, LIST, RESOLVE, sh, basename, dirname, join, ext, shorten, IMAGE } from "./paths.js";

const RECENT = "open-file.recent", KEEP = 30, RECENT_SHOWN = 5, ROWS = 12, LIMIT = 500;

export default class Ask {
  init(cx) {
    this.loc = location();
    this.text = ""; this.at = 0; this.error = null; this.home = this.loc.on ? null : home();
    this.listing = null; this.pending = null; this.resolving = false;
    this.input = InputState.new({ placeholder: "path/to/file, ../other, /absolute, ~/…" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; this.error = null; this.list(cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.list(cx);
  }

  dismiss() { closeOverlay(props().overlay); }

  // The typed path at its last "/": the folder to list and the name to match in it.
  split() {
    const i = this.text.lastIndexOf("/");
    return i < 0 ? { dir: "", base: this.text } : { dir: this.text.slice(0, i + 1), base: this.text.slice(i + 1) };
  }

  key() { return `${this.loc.on ?? ""}|${this.loc.cwd ?? ""}|${this.split().dir}`; }

  list(cx) {
    const key = this.key(), { dir } = this.split();
    if (this.listing?.key === key || this.pending === key) return;
    this.pending = key;
    cx.spawn(async (cx) => {
      let listing;
      try {
        const r = await sh(LIST, [this.loc.cwd ?? "", dir === "/" ? "/" : dir.replace(/\/$/, "")], this.loc.on);
        const f = r.stdout.split("\0");
        if (f[0] === "D") {
          const entries = f.slice(4).filter(Boolean).map((n) => (n.endsWith("/") ? { name: n.slice(0, -1), dir: true } : { name: n, dir: false }));
          listing = { key, abs: f[1], entries, error: null };
          if (f[3]) this.home = f[3];
        } else listing = { key, abs: null, entries: [], error: f[1] || "No such folder" };
      } catch (e) { listing = { key, abs: null, entries: [], error: String(e?.message ?? e) }; }
      if (this.pending === key) { this.pending = null; this.listing = listing; }
      cx.notify();
    });
  }

  rows() {
    const out = [];
    if (!this.text) for (const r of (shared(RECENT) ?? []).slice(0, RECENT_SHOWN)) out.push({ kind: "recent", path: r.path, on: r.on ?? null });
    const l = this.listing;
    if (l?.key === this.key() && l.abs) {
      const q = this.split().base.toLowerCase(), dots = q.startsWith(".");
      const pool = l.entries.filter((e) => dots || !e.name.startsWith("."));
      const starts = pool.filter((e) => e.name.toLowerCase().startsWith(q));
      const within = q ? pool.filter((e) => !e.name.toLowerCase().startsWith(q) && e.name.toLowerCase().includes(q)) : [];
      for (const e of [...starts, ...within]) out.push({ kind: "entry", name: e.name, dir: e.dir, path: join(l.abs, e.name) });
    }
    return out;
  }

  // Puts text in the input with the cursor at its end and lists its folder.
  retype(text, cx) {
    this.text = text; this.at = 0; this.error = null;
    this.input.set_value(text);
    this.input.set_selected_range({ start: text.length, end: text.length });
    this.list(cx);
    cx.notify();
  }

  complete(cx) {
    const r = this.rows()[this.at];
    if (!r) return;
    if (r.kind === "recent") return this.retype(r.path, cx);
    this.retype(this.split().dir + r.name + (r.dir ? "/" : ""), cx);
  }

  enter(cx) {
    const r = this.rows()[this.at];
    if (r?.kind === "recent") return this.open(r.path, r.on);
    if (r?.kind === "entry") return r.dir ? this.retype(this.split().dir + r.name + "/", cx) : this.open(r.path, this.loc.on);
    const typed = this.text.trim();
    if (!typed || this.resolving) return;
    // Nothing listed matches: ask the machine what the typed path is.
    const m = /^(.+?):(\d+)(?::\d+)?$/.exec(typed), path = m ? m[1] : typed, line = m ? +m[2] : null;
    this.resolving = true;
    cx.spawn(async (cx) => {
      try {
        const f = (await sh(RESOLVE, [this.loc.cwd ?? "", path], this.loc.on)).stdout.split("\0");
        if (f[0] === "dir") this.retype(typed.endsWith("/") ? typed : typed + "/", cx);
        else if (f[0] === "file") this.open(f[1], this.loc.on, line);
        else this.error = `No such file: ${path}`;
      } catch (e) { this.error = String(e?.message ?? e); }
      this.resolving = false;
      cx.notify();
    });
  }

  open(path, on, line = null) {
    const rest = (shared(RECENT) ?? []).filter((r) => !(r.path === path && (r.on ?? null) === (on ?? null)));
    setShared(RECENT, [{ path, on: on ?? null, at: Date.now() }, ...rest].slice(0, KEEP));
    this.dismiss();
    // A new tab of the space, named after the file, with the viewer as its only pane.
    run("tab.new", { name: basename(path), ...(this.loc.space ? { space: this.loc.space } : {}), mod: "open-file",
      props: { path, on: on ?? null, ...(line ? { line } : {}) } });
  }

  row(t, r, i, on) {
    const icon = r.kind === "entry" && r.dir ? "folder" : IMAGE.has(ext(r.path)) ? "image" : "file";
    const name = r.kind === "entry" ? r.name + (r.dir ? "/" : "") : basename(r.path);
    const where = r.kind === "recent" ? shorten(dirname(r.path), r.on ? (r.on === this.loc.on ? this.home : null) : home()) : "";
    return h_flex().id(`of-row-${i}`).mx(4).px(10).h(30).flex_none().rounded(7).gap(9).items_center().cursor_pointer()
      .when(on, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.at = i; this.enter(cx); })
      .child(svg(`mods/open-file/${icon}.svg`).size(14).flex_none().text_color(r.kind === "entry" && r.dir ? t.ansi4 : t.muted))
      .child(div().flex_none().truncate().max_w(360).text_color(t.foreground).child(name))
      .when(Boolean(where), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(where)))
      .when(r.kind === "recent" && (r.on ?? null) !== this.loc.on, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(10.5).text_color(t.muted).child(r.on ?? "this computer")));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const start = Math.max(0, Math.min(this.at - Math.floor(ROWS / 2), rows.length - ROWS));
    const shown = rows.slice(start, start + ROWS);
    const l = this.listing?.key === this.key() ? this.listing : null;
    const where = `${this.loc.on ?? "this computer"} · ${shorten(this.loc.cwd, this.home) || "~"}`;
    const note = this.error ? { text: this.error, color: t.blocked }
      : l?.error && this.text ? { text: l.error, color: t.dim }
      : this.text && l && !rows.length ? { text: "No match here · Enter tries the path as typed", color: t.dim }
      : l?.entries.length >= LIMIT ? { text: `Showing the first ${LIMIT} entries`, color: t.dim }
      : !l && this.pending ? { text: "Listing…", color: t.dim }
      : null;
    return v_flex().id("open-file-ask").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key, n = rows.length;
        if (k === "escape") return this.dismiss();
        if (k === "down" && n) this.at = (this.at + 1) % n;
        else if (k === "up" && n) this.at = (this.at + n - 1) % n;
        else if (k === "tab") this.complete(cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Open file"))
        .child(div().text_size(11).text_color(t.dim).child("Tab completes · Enter opens · Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/open-file/search.svg").size(15).flex_none().text_color(t.dim))
        .child(div().flex_none().max_w(260).truncate().text_size(11.5).text_color(t.dim).child(where))
        .child(div().flex_none().text_color(t.dim).child("/"))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(shown.length > 0, (el) => el.child(v_flex().id("of-list").min_h(0).mb(2)
        .on_scroll_wheel((e, cx) => {
          this.wheel = (this.wheel ?? 0) + e.delta.y;
          const steps = Math.trunc(this.wheel / 30);
          if (!steps) return;
          this.wheel -= steps * 30;
          this.at = Math.max(0, Math.min(rows.length - 1, this.at - steps));
          cx.notify();
        })
        .children(shown.map((r, i) => this.row(t, r, start + i, start + i === this.at)))))
      .when(Boolean(note), (el) => el.child(div().px(4).text_size(11.5).text_color(note.color).child(note.text)));
  }
}
