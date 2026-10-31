#!/bin/zsh
# Install (or reinstall) the runner as a launchd agent that starts at login and restarts if it dies.
#   ./install.sh            install + start
#   ./install.sh uninstall  stop + remove
set -euo pipefail

LABEL=com.brownridge.control-center.runner
PLIST=~/Library/LaunchAgents/$LABEL.plist
RUNNER=${0:A:h}/runner.mjs
LOG=~/Developer/ControlCenter/runner.log
NODE=$(command -v node)

launchctl bootout gui/$UID/$LABEL 2>/dev/null || true
if [[ ${1:-} == uninstall ]]; then
  rm -f $PLIST
  echo "Runner removed."
  exit 0
fi

# CC_OWNER_NAME=<your name> names you in agent prompts ("waiting on <name>");
# CC_MAX_CONCURRENT=<n> sets how many agent sessions run at once (default 2).
mkdir -p ~/Developer/ControlCenter ~/Library/LaunchAgents
cat > $PLIST <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$RUNNER</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>CC_OWNER_NAME</key><string>${CC_OWNER_NAME:-the owner}</string>
    <key>CC_MAX_CONCURRENT</key><string>${CC_MAX_CONCURRENT:-2}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap gui/$UID $PLIST
echo "Runner installed. Logs: $LOG"
