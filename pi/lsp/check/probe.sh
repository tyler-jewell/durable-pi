# Lists the language server and its tsserver child. Works on Linux and macOS (ps is on both). The patterns are split with
# quotes, so this script's own command line cannot match them.
ps -eo pid=,rss=,command= | while read -r pid rss rest; do
  case "$rest" in
    *typescript-language"-"server*) echo "RUNNING server pid=$pid rss_kb=$rss" ;;
    *tsserver"."js*) echo "RUNNING tsserver pid=$pid rss_kb=$rss" ;;
  esac
done
echo PROBE_END
