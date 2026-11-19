# Reports the language servers this Pi session started, found by ancestry (a Pi session of your own is not counted): the
# servers are children of Pi, which is one of the probe's ancestors. Prints a RUNNING line per server process and a COUNT line per
# server name, and the heap flag tsserver was started with. The runner checks after the session that none is left.
# Climb to the nearest Pi (its process title is "pi"), which is the one this check started, and no further: a Pi session
# above it, such as the one running this check, has servers of its own that must not be counted.
PI_PID=""
p=$$
while [ "$p" -gt 1 ]; do
  case "$(ps -ww -o command= -p "$p" | sed 's/ *$//')" in pi|pi\ *) PI_PID="$p"; break ;; esac
  p=$(ps -o ppid= -p "$p" | tr -d ' ')
  [ -n "$p" ] || break
done
ANCESTORS="$PI_PID"
SNAP="${TMPDIR:-/tmp}/dpi-probe.$$"
ps -ww -eo pid=,ppid=,rss=,command= > "$SNAP"
for name in typescript-language-"server" vue-language-"server" vscode-json-language-"server" vscode-css-language-"server" vscode-html-language-"server" bash-language-"server" pyright-lang"server"; do
  awk -v anc="$ANCESTORS" -v pat="$name" 'BEGIN { na = split(anc, a, " "); for (i = 1; i <= na; i++) own[a[i]] = 1 } ($2 in own) && index($0, pat) { n++; print "RUNNING " pat " pid=" $1 " rss_kb=" $3 } END { print "COUNT " pat " " n + 0 }' "$SNAP"
done
grep -o 'max-old-space-size=[0-9]*' "$SNAP" | head -1 | sed 's/^/HEAP /'
rm -f "$SNAP"
echo PROBE_END
