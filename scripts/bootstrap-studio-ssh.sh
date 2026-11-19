#!/usr/bin/env bash
# Bootstrap a machine as an SSH target behind Cloudflare Access.
# Runs as the login user, NO sudo required. Tested on macOS (userland sshd on :2222).
#
# Usage:
#   TUNNEL_TOKEN="<terraform output tunnel_token>" \
#   CA_PUBLIC_KEY="<terraform output short_lived_cert_ca_public_key>" \
#   SSH_PRINCIPALS="tyler.p.jewell vgrdz5h54y 1df3358ab9dc9c654a7ad631dc79aee2.access" \
#   HOSTNAME="studio.jewell-labs.com" \
#   ./bootstrap-studio-ssh.sh
#
# SSH_PRINCIPALS are the cert principals: email PREFIXES for humans, and the
# service-token client_id for the agent lane.

set -euo pipefail

: "${TUNNEL_TOKEN:?set TUNNEL_TOKEN}"
: "${CA_PUBLIC_KEY:?set CA_PUBLIC_KEY}"
: "${HOSTNAME:?set HOSTNAME}"
SSH_PRINCIPALS="${SSH_PRINCIPALS:-}"

UDIR="$HOME/.ssh/userland"
mkdir -p "$UDIR" "$HOME/.cloudflared" "$HOME/Library/LaunchAgents"

# --- cloudflared (tunnel connector) ---
command -v cloudflared >/dev/null 2>&1 || brew install cloudflared

# --- userland sshd ---
[ -f "$UDIR/ssh_host_ed25519_key" ] || \
  ssh-keygen -q -t ed25519 -f "$UDIR/ssh_host_ed25519_key" -N "" -C "userland-sshd-host"

cat > "$UDIR/sshd_config" <<CFG
Port 2222
ListenAddress 127.0.0.1
HostKey $UDIR/ssh_host_ed25519_key
PidFile $UDIR/sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile $UDIR/authorized_keys
AuthorizedPrincipalsFile $UDIR/authorized_principals
TrustedUserCAKeys $UDIR/cf-access-ca.pub
UsePAM no
StrictModes no
AllowTcpForwarding yes
CFG

echo "$CA_PUBLIC_KEY" > "$UDIR/cf-access-ca.pub"
: > "$UDIR/authorized_keys"
printf '%s\n' "$SSH_PRINCIPALS" | tr ' ' '\n' | sed '/^[[:space:]]*$/d' > "$UDIR/authorized_principals"
chmod 600 "$UDIR/cf-access-ca.pub" "$UDIR/authorized_keys" "$UDIR/authorized_principals"

# --- launchd: userland sshd ---
cat > "$HOME/Library/LaunchAgents/com.jewell-labs.userland-sshd.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jewell-labs.userland-sshd</string>
  <key>ProgramArguments</key><array>
    <string>/usr/sbin/sshd</string><string>-f</string><string>$UDIR/sshd_config</string><string>-D</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$UDIR/sshd.log</string>
  <key>StandardErrorPath</key><string>$UDIR/sshd.log</string>
</dict></plist>
PLIST

# --- launchd: cloudflared tunnel ---
cat > "$HOME/Library/LaunchAgents/com.jewell-labs.cloudflared-studio.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jewell-labs.cloudflared-studio</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>run</string>
    <string>--token</string>
    <string>$TUNNEL_TOKEN</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.cloudflared/cloudflared.log</string>
  <key>StandardErrorPath</key><string>$HOME/.cloudflared/cloudflared.log</string>
</dict></plist>
PLIST

# --- (re)load ---
launchctl unload "$HOME/Library/LaunchAgents/com.jewell-labs.userland-sshd.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.jewell-labs.cloudflared-studio.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.jewell-labs.userland-sshd.plist"
launchctl load "$HOME/Library/LaunchAgents/com.jewell-labs.cloudflared-studio.plist"

sleep 3
echo "=== sshd on :2222 ==="; lsof -nP -iTCP:2222 -sTCP:LISTEN || true
echo "=== cloudflared ==="; launchctl list | grep -E "cloudflared|userland-sshd" || true
echo "Done. Tunnel hostname: $HOSTNAME"
