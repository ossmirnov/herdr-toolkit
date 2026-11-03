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
