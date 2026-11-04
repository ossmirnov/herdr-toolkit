# herdr-toolkit

My [Herdr](https://herdr.dev) configuration. This repo *is* `~/.config/herdr-app`,
the folder the Herdr app reads on every start, so a commit here is the config
Herdr runs with (`~/herdr` is a symlink to it). `.gitignore` keeps out
everything the app writes itself: shipped mods and layouts, generated type
files, state, logs. Our own mods and layouts show up as untracked until added.

## What's here

| Path | What it is |
|---|---|
| `layouts/my-main.json` | The personal clone of Herdr's `main` layout ("Herdr"), the one shown. Its spaces sidebar runs `session-spaces`; its Files panel runs `my-files`. |
| `mods/session-spaces/` | The spaces sidebar, labelled by session instead of folder (below). A clone of Herdr's `spaces` mod. |
| `mods/my-files/` | The Files panel with git status colors: nested repos found, changed files and the folders holding them colored, the Changes panel dropped. A clone of Herdr's `files` mod. |
| `settings.json`, `keys.json` | Zoom, sounds, keys. `cmd-k` is the tab picker (Herdr's `cmd-p`), `cmd-p` opens a file. In terminals, alt+arrows and ctrl+arrows move by a word and cmd+arrows go to the line's ends: they send the Emacs keys (Meta-b, Meta-f, Ctrl-a, Ctrl-e) that zsh, bash and Claude Code's prompt understand; `vimrc` teaches Vim the two word keys. |
| `mods/pastes/` | The Pastes panel: everything pasted into a terminal that Claude Code folds into `[Pasted text #1 +N lines]`, shown in full (below). Hooks `cmd-v`. |
| `mods/open-file/` | `cmd-p`: open a file by path on the space's machine in a new tab, code with syntax colors, markdown rendered, images; `ctrl-,` wraps lines (below). The tab picker moved to `cmd-k`. |
| `vimrc` | Vim's configuration: the mouse on (`mouse=a`, SGR reporting), so a click in Vim moves the cursor, a drag selects and the wheel scrolls. `~/.vimrc` is a symlink to it here and a copy of it on other machines. |

## Space labels

Herdr names an unnamed space after where its first terminal is: its repo, else
its folder. With several spaces in the same repo that reads as `herdr`, `herdr`,
`herdr`. The `session-spaces` mod labels each space instead by:

1. the session name of the agent in the tab the space shows (Claude Code sets
   its terminal title to the session's name; Pi's "π - name - folder" title is
   reduced to the name, and an unnamed Pi session counts as none; a tab someone
   named counts too), else
2. the first other tab in the space that runs an agent, else
3. its number in the list, the same number the folded rail shows.

The colored avatar keeps the first letter of Herdr's own name for the space (its
repo or folder), so the color and letter still say where it is. No repo or
branch name is shown; ahead/behind counts still follow the label when not zero.

## Vim: the mouse and the word keys

Without a vimrc, Vim loads `defaults.vim`, the file that normally turns the
mouse on, but neither system ends up with it: macOS's `/usr/share/vim/vimrc`
sets `skip_defaults_vim` so it never loads, and Ubuntu ships a `defaults.vim`
with the mouse section removed. Either way `:set mouse?` in a Herdr terminal
gave `mouse=` and clicks only selected terminal text. `vimrc` here sets
`mouse=a` and `ttymouse=sgr`, and loads `defaults.vim` itself where the system
didn't opt out, so Ubuntu keeps its incsearch, wildmenu and scrolloff. Herdr
passes mouse events to programs that ask for them, local or remote, so clicking
in Vim moves the cursor, dragging selects in Vim and the wheel scrolls the
buffer. Hold Shift to select terminal text over Vim; right-click still opens
Herdr's menu.

Vim on another machine reads that machine's `~/.vimrc`, so copy the file to
each machine Herdr opens terminals on (`hc machine ls`), once:

```sh
hc file write --on devbox /home/oleg/.vimrc < ~/.config/herdr-app/vimrc
```

Herdr sends alt+arrows and ctrl+arrows to the program as Meta-b and Meta-f
(`keys.json`), which zsh, bash and Claude Code's prompt take as word moves but
terminal Vim sees as Esc then b or f. `vimrc` names those byte pairs as two
spare function keys, `<F35>` and `<F36>`, and maps them to Vim's `<C-Left>` and
`<C-Right>` in normal, insert and command-line mode. Vim takes the pair as one
key only when both bytes arrive within `ttimeoutlen` (100 ms), as a key press
delivers them, so a typed Esc still leaves insert mode. Nothing here is
shell-specific: there is no zshrc or inputrc to install, and the same vimrc
goes to every machine.

## Pastes: what Claude Code folded

Claude Code shows a long or multi-line paste as `[Pasted text #1 +N lines]`
and never shows the text itself, so a dictated message (Wispr Flow pastes what
it heard) can't be read back before Enter. The `pastes` mod keeps the text:

- `cmd-v` in a terminal runs `pastes.paste` (keys.json, `terminal` section)
  instead of `terminal.paste` directly. The mod reads the clipboard, pastes it
  exactly as before, and when the text is one Claude Code folds (three or more
  lines, or more than 800 characters: 2 lines and 700 characters stayed inline
  in Claude Code 2.1.317, 4 lines and 900 characters folded) it is logged and
  the Pastes panel opens on the right, where the Files panel is. Keyboard focus stays in the terminal: read, then press Enter.
- `cmd-shift-v` shows or hides the panel; `pastes.clear` empties the log.
- The panel shows the latest paste in a text area with the time, program and
  space it went to. **The panel is the source of truth: edit the text here and
  the terminal follows, with no button to press.** When typing pauses (0.7 s),
  the edit is saved to the log and mirrored into the terminal it came from:
  Backspace (`hc keys <t> backspace`, straight to the terminal, no focus moved)
  removes the `[Pasted text]` placeholder whole, then the keyboard moves to
  that terminal for one `terminal.paste` and comes straight back to the editor.
  Because it only fires on a pause, nothing is mid-keystroke during that move.
  Mirrors are serialised, so fast edits apply in order. A line in the meta row
  tracks it: `typing…`, `updating the terminal…`, `in the terminal`, or, if it
  couldn't, `not in the terminal: <why>`. `cmd-enter` in the editor moves the
  keyboard to the terminal, ready for Enter. Copy puts the text on the
  clipboard.
- If the same text is pasted again (Claude Code's own "paste again to expand",
  `cmd-v` twice), the entry is marked shown-in-full and left alone: Claude Code
  now holds the text literally, not a placeholder, so edit it there (`ctrl+g`
  opens it in Vim). The same text pasted twice within ten minutes is logged
  once. Earlier pastes are listed below (click to read, × to drop); edits to an
  older one stay in the panel and aren't mirrored. The log lives in
  `shared.json` (`pastes.log`, 40 entries, 400k characters at most), so it
  survives restarts. Short pastes are never kept, so a pasted password doesn't
  land there.
- Two copies in `layouts/my-main.json`: a floating block over the root
  (`pastes-hook`, props `{role: "hook"}`) that draws nothing and is always
  shown, because a mod command only reaches shown copies; and the `pastes`
  child of the `panel-body` stack. The hook adds `pastes` to the shared
  `workspace.panels` list so the tab bar remembers the panel per space.

Since the `terminal` key section beats `layout:<name>`, the `cmd-v` binding
applies on every layout, but only `my-main` carries the hook: on `main`,
`terminals` or `win98`, `cmd-v` pastes nothing until the same floating block
is added to a clone of that layout.

## Open file: `cmd-p`

Herdr binds `cmd-p` to its tab picker; here that is `cmd-k`, and `cmd-p` opens
a file wherever the focused space lives (devbox or this computer), the way an
editor's open-by-path does. The `open-file` mod is one mod with two faces:

- **The popup** (`mod.open:open-file`, a popup at the top like the picker's).
  The chip in the input shows where relative paths start: the machine and the
  focused terminal's live folder (a mod pane borrows its tab's first terminal).
  Type `src/main.py`, `../other/x.md`, `/abs/path`, `~/notes.md` or paste
  `path:42` from an error. As you type, the folder's entries that start with
  (then contain) the typed name are listed, 500 at most, dotfiles only when
  the name starts with a dot; `↑`/`↓` pick, `Tab` completes (a folder gets its
  `/`), `Enter` opens the picked entry (a folder: steps into it), `Esc` leaves.
  With nothing typed the last five opened files come first, with the machine
  when it isn't the current one. Enter on a path nothing listed matches asks
  the machine what it is. The folder listing and the probe are one `sh -c`
  each, run through `exec` on the space's machine (about 0.2 s to devbox),
  one listing per folder, not per keystroke. Recent files live in
  `shared.json` (`open-file.recent`, 30 entries).
- **The tab** it opens: `tab.new {name: <file name>, space, mod: "open-file",
  props: {path, on, line?}}`, a new tab of the space named after the file,
  with the viewer as its only pane (split a shell in beside it like any tab;
  `cmd-w` closes it). Text shows in Herdr's read-only `Editor` with syntax
  colors by extension, the same viewer and language table the Files panel's
  previews use (plus `Makefile`, `Dockerfile`, rc files); `.md` renders with
  `TextView.markdown`, with a Rendered/Source switch in the header; images
  (`png jpg jpeg gif webp bmp ico svg`) are fitted to the pane at up to their
  natural size (SVG scales up), with their pixel size in the header. The header
  shows the file name, folder, machine, size, the `:line` if one was typed,
  Wrap and `↻`. Wrap (or `ctrl-,`, `open-file.wrap` in keys.json) turns line
  wrapping on or off for every file tab at once (shared `open-file.wrap`; the
  editor is rebuilt, so it scrolls back to the top). The file is re-read when it changes: a folder watch on this computer, a
  `stat` every ten seconds on another machine. Files over 2 MB show their first
  400k characters; files with NUL bytes say "binary".
- **Images from another machine** come over as bytes with
  `hc exec --on <machine> -- cat <path>` (byte-exact; `readTextFile` is text
  only) into `data/open-file/<hash>-<mtime>.<ext>`, which `image()` reads as a
  path inside the app home. The copy is replaced when the file changes and
  deleted when the tab closes (`close()`); local images are copied the same
  way so there is one code path. Images over 50 MB are refused.

## Using it on another machine

Herdr creates `~/.config/herdr-app` on first start, so check the repo out into
the existing folder rather than cloning over it:

```sh
cd ~/.config/herdr-app
git init
git remote add origin git@github.com:ossmirnov/herdr-toolkit.git
git fetch origin
git checkout -f master          # overwrites settings.json and keys.json with the tracked ones
herdr-app do layout.switch '{"name":"my-main"}'
ln -s ~/.config/herdr-app/vimrc ~/.vimrc   # Vim with the mouse on (skip if you have a vimrc)
```

The chosen layout is remembered by the app (`shared.json`), so it comes back on
the next start. `ctrl-shift-l` cycles layouts if you want the shipped one back.

## Editing

Shipped mods and layouts are replaced on every start, so changes go in the
clones here (`herdr-app do mod.clone` / `layout.clone` make new ones). After
editing a mod:

```sh
herdr-app check ~/.config/herdr-app/mods/session-spaces
herdr-app shot /tmp/herdr.png   # the live window, for a look
```

The app's own `AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts` in this folder are
the reference for the mod API (regenerated by the app, not tracked).
