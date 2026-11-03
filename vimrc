" Vim in Herdr's terminals: the mouse moves the cursor, selects and scrolls.
"
" macOS's /usr/share/vim/vimrc sets skip_defaults_vim, so defaults.vim (the
" file that normally turns the mouse on in xterm-like terminals) is never
" loaded, and with no ~/.vimrc the mouse option stays empty. ~/.vimrc links
" here, so this file is Vim's personal configuration.
"
" With the mouse on, a click moves the cursor, a drag selects in Vim, and the
" wheel scrolls the buffer. Hold Shift to select terminal text instead; Herdr
" still opens its own menu on right-click.
if has('mouse')
  set mouse=a
  if has('mouse_sgr')
    " SGR reporting works past column 223 and in tmux.
    set ttymouse=sgr
  endif
endif
