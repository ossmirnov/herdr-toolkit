# Herdr terminals: ctrl+left and ctrl+right move by a word in zsh, as they
# already do in Vim, bash and Claude Code's prompt. Herdr sends them to the
# program as the xterm sequences; zsh's emacs keymap leaves those unbound and
# prints ";5D" / ";5C" instead. ~/.zshrc sources this file (see README).
bindkey '^[[1;5D' backward-word
bindkey '^[[1;5C' forward-word
