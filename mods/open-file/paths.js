// Shared by the popup and the viewer: where relative paths start, the shell probes
// that run on a machine, what a file is (its editor language, whether it's an image),
// and how paths and sizes are shown.
import { spaces, panes, focused, exec } from "herdr";

// Where relative paths resolve: the focused terminal's live folder, on its machine.
// A mod pane has no folder, so its tab's first terminal speaks for it.
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const tabCwd = f?.tab ? panes().find((p) => p.tab === f.tab && p.cwd)?.cwd : null;
  return { cwd: pane?.cwd || f?.cwd || tabCwd || space?.folder || null, on, space: space?.id ?? null };
}

// Runs a probe with `sh -c script open-file args...`, here or on a machine.
export function sh(script, args, on) {
  return exec("sh", ["-c", script, "open-file", ...args], { on: on ?? null });
}

// Lists a folder for completion. $1: where relative paths start, $2: the typed folder
// ("" = $1, "~" = home). Prints NUL-separated: "D", its absolute path, "H", the home,
// then each entry (folders end with "/"), the first 500; or "E" and why.
export const LIST = `cd -- "$1" 2>/dev/null || cd
d=$2
case "$d" in "") d=.;; "~") d=$HOME;; "~/"*) d=$HOME\${d#"~"};; esac
cd -- "$d" 2>/dev/null || { printf 'E\\0%s' "no such folder"; exit 0; }
printf 'D\\0%s\\0H\\0%s\\0' "$PWD" "$HOME"
ls -1ApL 2>/dev/null | head -n 500 | tr '\\n' '\\000'`;

// What a typed path is: "dir" or "file" (NUL, the absolute path, NUL, the size) or "missing".
export const RESOLVE = `cd -- "$1" 2>/dev/null || cd
p=$2
case "$p" in "~") p=$HOME;; "~/"*) p=$HOME\${p#"~"};; esac
if [ -d "$p" ]; then printf 'dir\\0%s\\0' "$(cd -- "$p" && pwd)"
elif [ -e "$p" ]; then printf 'file\\0%s/%s\\0%s' "$(cd -- "$(dirname -- "$p")" && pwd)" "$(basename -- "$p")" "$(wc -c < "$p" | tr -d ' ')"
else printf 'missing\\0%s\\0' "$p"; fi`;

// "size mtime" of a file (GNU or BSD stat), nothing when it's gone.
export const STAT = `if stat -c %Y / >/dev/null 2>&1; then stat -c '%s %Y' -- "$1" 2>/dev/null; else stat -f '%z %m' -- "$1" 2>/dev/null; fi`;

export const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
export const join = (dir, name) => (dir === "/" ? "/" + name : `${dir}/${name}`);
export const ext = (p) => { const n = basename(p); return n.includes(".") ? n.split(".").pop().toLowerCase() : ""; };

export function shorten(path, home) {
  if (!path || !home) return path ?? "";
  return path === home ? "~" : path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// The editor's language for a file, as the Files panel picks it: by extension, with the
// same aliases, plus a few names without one.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", json5: "json", svelte: "html", vue: "html", htm: "html", zsh: "sh", bash: "sh", pyi: "py", markdown: "md", mdx: "md", h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp" };
const NAMES = { makefile: "make", dockerfile: "dockerfile", ".zshrc": "sh", ".bashrc": "sh", ".profile": "sh", ".zprofile": "sh", ".env": "sh" };
export function language(path) {
  const name = basename(path).toLowerCase();
  if (NAMES[name]) return NAMES[name];
  const e = ext(path) || "txt";
  return LANG[e] ?? e;
}

export const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
export const isMarkdown = (path) => ["md", "markdown", "mdx"].includes(ext(path));

// Pixel size from an image file's header (PNG, GIF, BMP, WebP, JPEG), or null.
export function imageSize(b) {
  const n = b.length;
  const be16 = (i) => (b[i] << 8) | b[i + 1], le16 = (i) => b[i] | (b[i + 1] << 8);
  const be32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  if (n > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: be32(16), height: be32(20) };
  if (n > 10 && b[0] === 0x47 && b[1] === 0x49) return { width: le16(6), height: le16(8) };
  if (n > 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: le32(18), height: Math.abs(le32(22) | 0) };
  if (n > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (tag === "VP8L") { const bits = le32(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (tag === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (n > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: be16(i + 5), width: be16(i + 7) };
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

// An SVG's size from its width/height, else its viewBox; null when it says neither.
export function svgSize(text) {
  const head = /<svg[^>]*>/.exec(text)?.[0] ?? "";
  const attr = (name) => { const m = new RegExp(`\\s${name}="([\\d.]+)(?:px)?"`).exec(head); return m ? +m[1] : null; };
  const w = attr("width"), h = attr("height");
  if (w && h) return { width: w, height: h };
  const vb = /\sviewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(head);
  return vb ? { width: +vb[1], height: +vb[2] } : null;
}
