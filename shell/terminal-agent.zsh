# Load into the current interactive zsh: eval "$(terminal-agent shell init zsh)"
[[ -o interactive ]] || return 0
# Widgets can be retained by other plugins even after accept-line is restored.
# Keep their callback alive and make source idempotently refresh definitions.
typeset -gi TERMINAL_AGENT_ENABLED=1

typeset -g TERMINAL_AGENT_ROOT="${${(%):-%x}:A:h:h}"
# Resolve Node once; the command path and arguments are never eval'd.
typeset -g TERMINAL_AGENT_NODE="${TERMINAL_AGENT_NODE:-${commands[node]}}"
if [[ -z "$TERMINAL_AGENT_NODE" ]]; then
  print -u2 'terminal-agent: 需要 Node.js >=22'
  return 1
fi

function _terminal_agent_route() {
  emulate -L zsh
  setopt extendedglob
  local line="${1##[[:space:]]#}" first
  [[ "${TERMINAL_AGENT_ROUTING_MODE:-auto}" == explicit ]] && { REPLY=shell; return; }
  local -a words
  words=( ${(z)line} )
  first="${(Q)words[1]}"
  REPLY=shell
  [[ -z "$line" ]] && return
  # Preserve compound/multiline shell editing, comments, assignments, expansion,
  # redirection and history syntax. Never run input to determine its meaning.
  [[ "$line" == *$'\n'* || "$line" == \#* || "$line" == \!* || "$line" == [\$\`\(\{\<\>\~\/\.]* || "$first" == [A-Za-z_][A-Za-z0-9_]#=* ]] && return
  # Known commands, aliases, functions and shell syntax normally take the fast path.
  if whence -w -- "$first" >/dev/null 2>&1; then
    # Common English instructions that also start with a Unix command are ambiguous.
    if [[ "$line" =~ '^(find|install|sort|make|test) (the |all |large |largest |smallest |files |a |an )' || "$line" =~ '^(git|docker|kubectl|npm|pnpm|cargo|find|install|sort|make|test) +(帮我|请帮|如何|怎么|能否|please |help me )' ]]; then REPLY=classify; fi
    return
  fi
  case "$first" in
    if|then|else|elif|fi|for|while|until|do|done|case|esac|select|repeat|function|time|coproc|nocorrect|noglob) return ;;
  esac
  if [[ "$line" =~ '[一-龥]' || "$line" =~ '^(please|help|show|check|list|explain|create|remove|delete|move|rename|why|how|what|can|could|fix|帮|请)' ]]; then
    REPLY=agent
  else
    REPLY=classify
  fi
}

function _terminal_agent_accept_line() {
  emulate -L zsh
  setopt localoptions extendedglob
  if (( ! TERMINAL_AGENT_ENABLED )); then
    zle _terminal_agent_original_accept_line
    return
  fi
  local REPLY line="$BUFFER" answer
  # ZLE stores previously accepted lines of an incomplete command here.
  # A continuation must never be reclassified as a new natural-language task.
  if [[ -n "$PREBUFFER" ]]; then
    zle _terminal_agent_original_accept_line
    return
  fi
  _terminal_agent_route "$line"
  if [[ "$REPLY" == shell ]]; then
    zle _terminal_agent_original_accept_line
    return
  fi
  local routing_mode
  routing_mode=$("$TERMINAL_AGENT_NODE" "$TERMINAL_AGENT_ROOT/bin/terminal-agent.mjs" route-mode </dev/null)
  if [[ "$routing_mode" == explicit ]]; then
    zle _terminal_agent_original_accept_line
    return
  fi
  zle -I
  if [[ "$REPLY" == classify ]]; then
    print -u2 '正在识别输入意图…'
    REPLY=$("$TERMINAL_AGENT_NODE" "$TERMINAL_AGENT_ROOT/bin/terminal-agent.mjs" classify "$line" </dev/null)
    local classify_status=$?
    if (( classify_status == 130 )); then zle reset-prompt; return; fi
    if [[ "$REPLY" == shell ]]; then
      zle _terminal_agent_original_accept_line
      return
    fi
    [[ "$REPLY" == agent ]] || REPLY=ask
  fi
  if [[ "$REPLY" == ask ]]; then
    read -r 'answer?输入有歧义：[a] 自然语言 / [s] shell / [其他] 返回编辑：' </dev/tty
    if [[ "$answer" == s ]]; then
      zle _terminal_agent_original_accept_line
      return
    elif [[ "$answer" != a ]]; then
      zle reset-prompt
      return
    fi
  fi
  print -s -- "$line"
  BUFFER=''
  # ZLE owns shell input while a widget runs. Open the concrete terminal
  # device: on macOS Bun cannot poll the /dev/tty alias with kqueue.
  "$TERMINAL_AGENT_NODE" "$TERMINAL_AGENT_ROOT/bin/terminal-agent.mjs" ask "$line" < "${TTY:-/dev/tty}"
  zle reset-prompt
}

function terminal-agent-off() {
  # Autosuggestions and highlighting may hold wrappers pointing at this
  # callback. Removing it or restoring an old wrapper corrupts their chain.
  typeset -gi TERMINAL_AGENT_ENABLED=0
  print 'terminal-agent 已关闭'
}

# Preserve an existing command/alias/function named ta. Refresh our own wrapper
# when sourcing again, including after an npm upgrade at a new package path.
if [[ "${functions[ta]-}" == *TERMINAL_AGENT_ROOT* ]] || ! whence -w ta >/dev/null 2>&1; then
  function ta() {
    if [[ "$1" == shell && "$#" == 2 ]]; then
      case "$2" in
        off) terminal-agent-off; return ;;
        on) typeset -gi TERMINAL_AGENT_ENABLED=1; print 'terminal-agent 已启用'; return ;;
        status) print "terminal-agent enabled=$TERMINAL_AGENT_ENABLED accept-line=${widgets[accept-line]} ta=wrapper"; return ;;
      esac
    fi
    "$TERMINAL_AGENT_NODE" "$TERMINAL_AGENT_ROOT/bin/terminal-agent.mjs" "$@"
  }
else
  print -u2 'terminal-agent: ta 已存在，保留原定义；请使用完整命令 terminal-agent。'
fi

function terminal-agent() {
  if [[ "$1" == shell && "$#" == 2 ]]; then
    case "$2" in
      off) terminal-agent-off; return ;;
      on) typeset -gi TERMINAL_AGENT_ENABLED=1; print 'terminal-agent 已启用'; return ;;
      status) print "terminal-agent enabled=$TERMINAL_AGENT_ENABLED accept-line=${widgets[accept-line]}"; return ;;
    esac
  fi
  "$TERMINAL_AGENT_NODE" "$TERMINAL_AGENT_ROOT/bin/terminal-agent.mjs" "$@"
}

if (( ! ${+widgets[_terminal_agent_original_accept_line]} )); then
  zle -A accept-line _terminal_agent_original_accept_line
  zle -N accept-line _terminal_agent_accept_line
fi
print 'terminal-agent 已启用：自然语言直接回车；ta 可强制进入 agent；terminal-agent-off 关闭。'
