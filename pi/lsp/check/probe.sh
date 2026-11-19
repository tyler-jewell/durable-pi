# Lists the language server and its tsserver child. Uses ps where it exists (Linux and macOS) and /proc where it does not
# (the Node container image has no ps). The patterns are split with quotes, so this script's own command line cannot match.
report() {
  case "$2" in
    *typescript-language"-"server*) echo "RUNNING server pid=$1 rss_kb=$3" ;;
    *tsserver"."js*) echo "RUNNING tsserver pid=$1 rss_kb=$3" ;;
  esac
}
if command -v ps >/dev/null 2>&1; then
  ps -eo pid=,rss=,command= | while read -r pid rss rest; do report "$pid" "$rest" "$rss"; done
else
  for p in /proc/[0-9]*; do
    cmd=$(tr "\0" " " < "$p/cmdline" 2>/dev/null) || continue
    rss=$(awk '/VmRSS/{print $2}' "$p/status" 2>/dev/null)
    report "$(basename "$p")" "$cmd" "$rss"
  done
fi
echo PROBE_END
