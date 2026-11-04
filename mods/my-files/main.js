// A lazy file browser for the focused pane's folder, with git status colors.
// Click a file: it opens in a new tab of the space, as Cmd-P (open-file) does.
// Right-click a file or folder: its path, relative to the folder shown (the
// focused terminal's cwd), is copied, ready to paste to an agent.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id ?? null };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;
// Cmd-P's recent files (shared with the open-file mod), so files opened here show there too.
const RECENT = "open-file.recent", KEEP = 30;
const COPIED_FOR = 1500;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Reparse points keep directory attributes even when dangling; check their target.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Every repo at or under the folder (nested repos and submodules too, even ones
// the parent ignores), and each one's uncommitted changes, in one shell call.
const GIT_SCRIPT = 'cd "$1" || exit 1; top=$(git rev-parse --show-toplevel 2>/dev/null); '
  + '{ [ -n "$top" ] && echo "$top"; find . -maxdepth 6 \\( -name node_modules -o -name .venv -o -name venv -o -name __pycache__ -o -name target \\) -prune -o -name .git -print -prune 2>/dev/null | head -200 | while read -r g; do d=${g%/.git}; d=${d#.}; echo "$PWD$d"; done; } | sort -u | while read -r r; do '
  + 'printf "R:%s\\0" "$r"; git -C "$r" --no-optional-locks -c core.fsmonitor=false status --porcelain=v1 -z --no-renames --untracked-files=all 2>/dev/null | head -c 2000000; done';

async function gitMarks(cwd, on) {
  if (!on && window()?.platform === "windows") return {};
  const r = await exec("sh", ["-c", GIT_SCRIPT, "files", cwd], { on });
  if (r.code !== 0 && !r.stdout) return {};
  const files = {}, repos = new Set();
  let repo = null, count = 0;
  const fields = r.stdout.split("\0").filter(Boolean);
  for (const f of fields) if (f.startsWith("R:")) repos.add(f.slice(2));
  for (const f of fields) {
    if (f.startsWith("R:")) { repo = f.slice(2); continue; }
    if (!repo || f.length < 4 || ++count > TOTAL) continue;
    const xy = f.slice(0, 2), path = `${repo}/${f.slice(3)}`.replace(/\/$/, "");
    // A nested repo seen from its parent: its own status speaks for it.
    if (repos.has(path)) continue;
    files[path] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
  }
  // Folders take their contents' state: conflicts win, one kind keeps its color, a mix is "modified".
  const marks = { ...files }, folders = {};
  const root = cwd.replace(/\/$/, "");
  for (const [path, mark] of Object.entries(files)) {
    for (let dir = path.slice(0, path.lastIndexOf("/")); dir.length > root.length && dir.startsWith(root + "/"); dir = dir.slice(0, dir.lastIndexOf("/"))) {
      const was = folders[dir];
      folders[dir] = !was || was === mark ? mark : was === "U" || mark === "U" ? "U" : "M";
    }
  }
  for (const [dir, mark] of Object.entries(folders)) marks[dir] = mark;
  return marks;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.copied = null;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on, space } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.copied = null; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const marks = await gitMarks(cwd, on).catch(() => ({}));
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Opens the file in a new tab of the space, exactly as Cmd-P does: the open-file
  // viewer as the tab's only pane, and the file first in Cmd-P's recent list.
  open(path) {
    const { root, on, space } = this.context;
    const abs = `${root.replace(/[\\/]$/, "")}/${path}`;
    const rest = (shared(RECENT) ?? []).filter(r => !(r.path === abs && (r.on ?? null) === (on ?? null)));
    setShared(RECENT, [{ path: abs, on: on ?? null, at: Date.now() }, ...rest].slice(0, KEEP));
    run("tab.new", { name: path.slice(path.lastIndexOf("/") + 1), ...(space ? { space } : {}), mod: "open-file", props: { path: abs, on: on ?? null } });
  }

  // Copies the path as the tree shows it: relative to the shown folder, no trailing slash.
  copy(path, cx) {
    cx.write_to_clipboard(path);
    this.copied = path;
    cx.notify();
    cx.timer.after(COPIED_FOR, cx => { if (this.copied === path) { this.copied = null; cx.notify(); } });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const color = mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : mark ? t.ansi3 : null;
      const copied = this.copied === path;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.open(path))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.copy(path, cx); })
        .child(entry.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/my-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(color ?? t.muted))
        .child(div().flex_1().min_w(0).truncate().when(Boolean(color), el => el.text_color(color)).child(entry.name))
        .when(copied, el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.accent).text_size(10.5).text_color(t.accent_foreground).child("Copied")))
        .when(!copied && Boolean(mark) && entry.dir, el => el.child(div().size(6).flex_none().rounded(3).bg(color)))
        .when(!copied && Boolean(mark) && !entry.dir, el => el.child(div().text_size(11).text_color(color).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
