// Pastes: what Claude Code folds into "[Pasted text #1 +N lines]", in full,
// editable, and mirrored back into the terminal as you edit.
//
// Two roles, from the layout's props:
// - { role: "hook" }: a floating block that draws nothing. keys.json sends it
//   cmd-v as "pastes.paste": it reads the clipboard, pastes as Herdr always
//   did (terminal.paste), and when the text is one Claude Code would fold
//   (three or more lines, or over 800 characters) it is logged and the panel
//   opens. The same text pasted again is Claude Code's own "paste again to
//   expand": the entry is marked inline and left alone from then on.
//   "pastes.toggle" shows or hides the panel, "pastes.clear" empties the log.
// - the panel (no role; or { role: "window" } as an overlay when the layout
//   has no "pastes" node): the latest paste in a text area, the earlier ones
//   below it. Edits are saved into the log and, for the newest paste, mirrored
//   into the terminal it went to once typing pauses: Backspace (sent straight
//   to that terminal through hc) removes the placeholder whole, or a short
//   inline text one character at a time; then, in one tick, the keyboard goes
//   to that terminal, the text is pasted, and the keyboard comes back, so
//   nothing can be typed into the terminal in between. cmd-enter applies and
//   goes to the terminal, ready for Enter. Copy puts the text on the clipboard.
//
// The log lives in shared("pastes.log") so both copies see it, and survives
// restarts (shared.json). Only folded pastes are kept: a one-line password
// never lands here. Checked by pasting into Claude Code 2.1.317: 2 lines or
// 700 characters stay inline, 4 lines or 900 characters fold; one Backspace
// empties a placeholder; an identical second paste expands it in place.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState } from "gpui-base";
import { props, run, hc, shared, setShared, focused, panes, spaces, nextCommand, theme, layout, openOverlay, closeOverlay } from "herdr";

const KEY = "pastes.log";
const MAX_ENTRIES = 40, MAX_CHARS = 400000;
// Claude Code folds a paste of this many lines or more, or longer than this.
const LINES = 3, LONG = 800;
// Typing pauses this long before an edit is written and mirrored.
const SETTLE = 700;
// A paste gets this long to land before the next Backspace goes out.
const LANDED = 300;

const folds = (text) => text.split("\n").length >= LINES || text.length > LONG;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function trim(log) {
  const out = [];
  let total = 0;
  for (const e of log) {
    total += e.text.length;
    if (out.length >= MAX_ENTRIES || total > MAX_CHARS) break;
    out.push(e);
  }
  return out;
}

const two = (n) => String(n).padStart(2, "0");
function clock(at) {
  const d = new Date(at), now = new Date();
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${two(d.getDate())}.${two(d.getMonth() + 1)} ${time}`;
}
const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const preview = (text) => (text.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 120);
const readLog = () => (Array.isArray(shared(KEY)) ? shared(KEY) : []);
// What the terminal holds for an entry: the text last put there ("" after a failed paste).
const held = (e) => e.applied ?? e.original ?? e.text;

function patch(id, fields) {
  const log = readLog(), i = log.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const next = log.slice();
  next[i] = { ...log[i], ...fields };
  setShared(KEY, next);
  return next[i];
}

export default class Pastes extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "panel";
    if (this.role === "hook") {
      // Let the tab bar remember this panel per space like Files and Changes.
      const enabled = shared("workspace.panels");
      if (Array.isArray(enabled) && !enabled.includes("pastes")) setShared("workspace.panels", [...enabled, "pastes"]);
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          try {
            if (c === "paste") this.paste(cx);
            else if (c === "toggle") this.toggle();
            else if (c === "clear") setShared(KEY, []);
          } catch (e) {
            console.log(`pastes: ${c} failed: ${e?.stack ?? e}`);
          }
        }
      });
      return;
    }
    this.area = TextareaState.new({ value: "", rows: 12 });
    this.area.set_soft_wrap(true);
    this.area.on("change", (_e, cx) => this.changed(cx));
    this.area.on("focus", () => { this.areaFocused = true; });
    this.area.on("blur", (_e, cx) => { this.areaFocused = false; this.flush(cx); });
    this.areaFocused = false;
    this.viewerFor = null;   // the entry the text area holds
    this.setting = false;    // set_value in progress: not an edit
    this.draft = null;       // { id, text }: an edit not yet written to the log
    this.changedAt = 0;
    this.shown = null;       // an entry id the person picked; null follows the newest
    this.newest = null;
    this.queue = Promise.resolve();   // mirrors run one after another
    this.busy = null;        // the entry being mirrored
    this.problem = null;     // { id, text }: why the last mirror didn't land
  }

  // cmd-v in a terminal. The clipboard is read first, then Herdr pastes it as
  // before; the log comes last so nothing in it can hold the paste back.
  paste(cx) {
    let text;
    try { text = cx.read_from_clipboard(); } catch { text = undefined; }
    const f = focused();
    run("terminal.paste");
    if (typeof text !== "string" || !folds(text)) return;
    const log = readLog();
    if (log[0]?.text === text && Date.now() - log[0].at < 10 * 60000) {
      // The same text again: Claude Code shows it in full now, in place.
      if (!log[0].inline) patch(log[0].id, { inline: true });
      return;
    }
    const pane = f?.terminal ? panes().find((p) => p.terminal === f.terminal) : null;
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs.find((t) => t.id === f?.tab);
    const entry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(), text, applied: text,
      terminal: f?.terminal ?? null,
      program: pane?.program?.name ?? null,
      space: space?.name ?? null,
      tab: tab?.name ?? null,
      lines: text.split("\n").length, chars: text.length,
    };
    setShared(KEY, trim([entry, ...log]));
    if (props()?.open !== false) this.show();
  }

  nodes() {
    const root = layout();
    return { panel: find(root, "panel"), body: find(root, "panel-body"), pastes: find(root, "pastes") };
  }

  show() {
    const { panel, pastes } = this.nodes();
    if (panel && pastes) {
      run("layout.select", { stack: "panel-body", child: "pastes" });
      run("layout.show", { id: "panel" });
    } else {
      openOverlay({ mod: "pastes", props: { role: "window" }, kind: "window", key: "pastes", width: 540, height: 620 });
    }
  }

  toggle() {
    const { panel, body, pastes } = this.nodes();
    if (panel && pastes && !panel.hidden && body?.active === "pastes") run("layout.hide", { id: "panel" });
    else this.show();
  }

  close(cx) {
    this.flush(cx);
    if (this.role === "window") closeOverlay(props().overlay);
    else run("layout.hide", { id: "panel" });
  }

  // Editing. A change becomes a draft for the entry the area holds, written to
  // the log and mirrored once typing pauses, on blur, and before any action
  // uses the text.
  changed(cx) {
    if (this.setting || !this.viewerFor) return;
    const value = this.area.value();
    const entry = readLog().find((e) => e.id === this.viewerFor);
    if (entry && entry.text !== value) {
      this.draft = { id: entry.id, text: value };
      this.changedAt = Date.now();
      cx.timer.after(SETTLE, (cx) => { if (Date.now() - this.changedAt >= SETTLE - 20) this.flush(cx); });
    } else if (this.draft?.id === this.viewerFor) {
      this.draft = null;
    }
  }

  flush(cx) {
    const d = this.draft;
    if (!d) return;
    this.draft = null;
    const before = readLog().find((e) => e.id === d.id);
    if (!before || before.text === d.text) return;
    const original = before.original ?? before.text;
    const entry = patch(d.id, { original, text: d.text, edited: d.text !== original, lines: d.text.split("\n").length, chars: d.text.length });
    if (entry) this.apply(entry, cx);
  }

  text(entry) {
    return this.viewerFor === entry.id ? this.area.value() : entry.text;
  }

  copy(entry, cx) {
    const text = this.text(entry);
    this.flush(cx);
    cx.write_to_clipboard(text);
  }

  // Queues a mirror of the newest paste's text into its terminal. Mirrors run
  // one at a time; each reads the entry's latest text when its turn comes.
  apply(entry, cx) {
    if (entry.inline || !entry.terminal || entry.text === held(entry)) return;
    if (entry.id !== readLog()[0]?.id) return;
    const prev = this.queue;
    let done;
    this.queue = new Promise((r) => { done = r; });
    cx.spawn(async (cx) => {
      try {
        await prev;
        await this.mirror(entry.id, cx);
      } catch (e) {
        this.problem = { id: entry.id, text: String(e?.message ?? e) };
        console.log(`pastes: mirror failed: ${e?.stack ?? e}`);
      } finally {
        done();
        this.busy = null;
        cx.notify();
      }
    });
  }

  // Makes the terminal hold the entry's text, then leaves the keyboard where
  // it found it. Two steps:
  //  1. Remove what the terminal holds. Backspace goes straight to the
  //     terminal through the core (hc keys), so no focus is moved: one press
  //     for a folded placeholder, one per character for a short inline text.
  //  2. Paste the new text. terminal.paste goes to the focused pane, so the
  //     keyboard moves to the terminal for that one call and back to the
  //     editor after. This only runs on a typing pause, so nothing is
  //     mid-keystroke, and command order (focus, paste, refocus) is kept.
  async mirror(id, cx) {
    const entry = readLog().find((e) => e.id === id);
    if (!entry || entry.inline) return;
    const text = entry.text, have = held(entry), terminal = entry.terminal;
    if (text === have) return;
    if (!terminal || !panes().some((p) => p.terminal === terminal)) { this.problem = { id, text: "its terminal is gone" }; return; }
    this.busy = id;
    this.problem = null;
    cx.notify();
    const presses = folds(have) ? 1 : [...have].length;
    if (presses > 0) {
      const r = await hc(["keys", terminal, ...Array(presses).fill("backspace")]);
      if (r.code !== 0) { this.problem = { id, text: (r.stderr || r.stdout).trim() || "Backspace failed" }; return; }
      patch(id, { applied: "" });
    }
    const back = this.areaFocused;
    cx.write_to_clipboard(text);
    run("pane.focus", { terminal });
    run("terminal.paste");
    patch(id, { applied: text });
    // Reclaim the keyboard for the editor (a second try after the paste lands,
    // as focus can need a beat to come back, like the prompt mod's re-focus).
    if (back) { this.area.focus(); cx.timer.after(150, () => this.area.focus()); }
    await cx.sleep(LANDED);
  }

  render(cx) {
    if (this.role === "hook") return div();
    const t = theme();
    const log = readLog();
    if (log[0]?.id !== this.newest) { this.newest = log[0]?.id ?? null; this.shown = null; }
    const current = (this.shown && log.find((e) => e.id === this.shown)) || log[0] || null;
    if ((current?.id ?? null) !== this.viewerFor) {
      // A draft keeps its own entry id, so a pending one still lands right.
      this.setting = true;
      this.viewerFor = current?.id ?? null;
      this.area.set_value(current?.text ?? "");
      this.setting = false;
    }

    const button = (id, label, action) => h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6).text_size(11.5).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(label);
    const dim = (text) => div().flex_none().text_size(11.5).text_color(t.dim).child(text);
    const remove = (id) => (_e, cx) => {
      cx.stop_propagation();
      if (this.shown === id) this.shown = null;
      if (this.draft?.id === id) this.draft = null;
      setShared(KEY, log.filter((e) => e.id !== id));
    };

    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Pastes"))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.dim).child(log.length ? count(log.length, "paste") : ""))
      .when(log.length > 0, (el) => el.child(button("pastes-clear", "Clear", () => { this.shown = null; this.draft = null; setShared(KEY, []); })))
      .child(div().id("pastes-close").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.close(cx)).child("×"));

    const empty = v_flex().flex_1().min_h(0).p(18).gap(10).text_size(12.5).text_color(t.muted)
      .child(div().text_color(t.foreground).font_medium().child("Nothing pasted yet"))
      .child(div().child("Paste or dictate into a terminal. Anything Claude Code shows as [Pasted text #1 +N lines] lands here in full. Read it, fix it here, and the terminal follows; then press Enter there."))
      .child(div().text_color(t.dim).child("Cmd+Shift+V shows or hides this panel. Only what Claude Code folds is kept: three or more lines, or more than 800 characters."))
      .child(div().text_color(t.dim).child("Claude Code itself expands a placeholder when the same text is pasted again (cmd-v twice), and one Backspace removes it whole."));

    let meta = null, editor = null, hint = null;
    if (current) {
      const newest = current.id === log[0]?.id;
      const where = [current.program, current.space, current.tab && !/^\d+$/.test(current.tab) ? current.tab : null].filter(Boolean).join(" · ");
      const pending = this.draft?.id === current.id || current.text !== held(current);
      const status = current.inline ? "shown in full in the terminal"
        : !newest ? ""
        : this.busy === current.id ? "updating the terminal…"
        : this.problem?.id === current.id ? `not in the terminal: ${this.problem.text}`
        : pending ? "typing…"
        : current.edited ? "in the terminal" : "";
      meta = h_flex().flex_none().px(14).pt(10).pb(6).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
          .child(`${clock(current.at)}${where ? " · " + where : ""} · ${count(current.lines, "line")} · ${count(current.chars, "char")}${status ? " · " + status : ""}`))
        .child(button("pastes-copy", "Copy", (_e, cx) => this.copy(current, cx)));
      editor = div().id("pastes-edit").flex_1().min_h(0).px(8)
        .on_key_down((e, cx) => {
          if (e.keystroke !== "cmd-enter") return;
          cx.stop_propagation();
          this.flush(cx);
          const queue = this.queue, terminal = current.terminal;
          cx.spawn(async () => { await queue; if (terminal) run("pane.focus", { terminal }); });
        })
        .child(Textarea.new(this.area).size_full());
      hint = div().flex_none().px(14).pt(6).pb(8).text_size(11).text_color(t.dim)
        .child(current.inline
          ? "Claude Code shows this text in full in its input now. Edit it there (ctrl+g opens it in Vim); edits here stay here."
          : !newest
            ? "An earlier paste. Edits stay here; Copy puts the text on the clipboard."
            : "Edits go to the terminal when you pause: Backspace removes its [Pasted text] placeholder, then the new text is pasted. Keep the placeholder last in Claude Code's input. ⌘↩ then goes to the terminal, ready for Enter.");
    }

    const row = (e) => {
      const on = e.id === current?.id;
      return h_flex().id(`pastes-row-${e.id}`).h(28).px(10).gap(8).flex_none().items_center().rounded(6)
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(on ? t.selected : t.hover))
        .cursor_pointer().on_click((_e, cx) => { this.flush(cx); this.shown = e.id; cx.notify(); })
        .child(dim(clock(e.at)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(preview(e.text)))
        .child(dim(e.lines > 1 ? count(e.lines, "line") : count(e.chars, "char")))
        .child(div().id(`pastes-rm-${e.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(remove(e.id)).child("×"));
    };
    const history = log.length > 1 && v_flex().flex_none().border_t(1).border_color(t.border)
      .child(div().px(14).pt(8).pb(4).text_size(11).font_medium().text_color(t.dim).child("All pastes"))
      .child(v_flex().id("pastes-history").max_h(200).overflow_y_scrollbar().px(6).pb(6).gap(1).children(log.map(row)));

    return v_flex().id("pastes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(header)
      .when(!current, (el) => el.child(empty))
      .when(Boolean(current), (el) => el.child(meta).child(editor).child(hint))
      .when(Boolean(history), (el) => el.child(history));
  }
}
