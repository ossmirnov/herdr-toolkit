" Vim with the mouse on, in Herdr's terminals here and on other machines.
"
" Without a vimrc, Vim loads defaults.vim, which is what normally turns the
" mouse on, but neither system we run on ends up with it: macOS's
" /usr/share/vim/vimrc sets skip_defaults_vim so it never loads, and
" Ubuntu/Debian ship a defaults.vim with the mouse section removed. Either
" way `:set mouse?` gave `mouse=` and clicks only selected terminal text.
"
" ~/.vimrc links to this file here and is a copy of it on other machines
" (see README). A vimrc of our own stops Vim loading defaults.vim by itself,
" so load it here where the system didn't opt out: Ubuntu keeps its
" incsearch, wildmenu and scrolloff; macOS stays as it was.
if !exists('g:skip_defaults_vim') && filereadable($VIMRUNTIME . '/defaults.vim')
  source $VIMRUNTIME/defaults.vim
endif

" A click moves the cursor, a drag selects in Vim and the wheel scrolls the
" buffer. Hold Shift to select terminal text instead; Herdr still opens its
" own menu on right-click.
if has('mouse')
  set mouse=a
  if has('mouse_sgr')
    " SGR reporting works past column 223 and in tmux.
    set ttymouse=sgr
  endif
endif

" Herdr sends alt+arrows and ctrl+arrows to the program as Meta-b and Meta-f
" (keys.json), the word keys zsh, bash and Claude Code's prompt understand.
" Terminal Vim sees a raw Esc b / Esc f instead. Name those byte pairs as two
" spare function keys and make them Vim's own word keys in normal, insert and
" command-line mode. (<M-b> itself would do, but with UTF-8 Vim turns it into
" the 8-bit character "â" in insert mode.) Vim takes the pair as one key only
" when both bytes arrive together (ttimeoutlen), as a key press delivers them,
" so a typed Esc still leaves insert mode as usual.
if !has('nvim')
  execute "set <F35>=\eb"
  execute "set <F36>=\ef"
  set ttimeout ttimeoutlen=100
  noremap  <F35> <C-Left>
  noremap! <F35> <C-Left>
  noremap  <F36> <C-Right>
  noremap! <F36> <C-Right>
endif

" Ctrl+C with text selected copies it to the Mac's clipboard, as in every
" other Mac app. Vim's own Ctrl+C in Visual mode only ended the selection;
" Esc still does that. The mapping yanks as usual, then copies the yank where
" this Vim can reach the Mac's clipboard, decided when the key is pressed, not
" here: the Mac's system Vim (+clipboard) connects its clipboard after startup,
" so has('clipboard_working') is 0 while this file loads and 1 afterwards.
" - A working clipboard: "+ is the macOS pasteboard.
" - None (devbox's Vim is built without one, and over ssh the clipboard that
"   matters is the Mac's anyway): write the text to the terminal as an OSC 52
"   clipboard write. Herdr puts it on the Mac's clipboard, from a remote
"   terminal too (up to 1 MiB; settings.json's clipboard_write: false blocks it).
function! s:CopyYank() abort
  if has('clipboard_working')
    call setreg('+', @", getregtype('"'))
  else
    let b64 = substitute(system('base64', @"), '\n', '', 'g')
    call echoraw("\e]52;c;" . b64 . "\x07")
  endif
endfunction
vnoremap <silent> <C-c> y:call <SID>CopyYank()<CR>
