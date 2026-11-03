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
