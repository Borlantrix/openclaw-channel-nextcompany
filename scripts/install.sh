#!/bin/bash
set -e

# OpenClaw NextCompany Plugin — Install/Update Script
# Usage: curl -fsSL https://raw.githubusercontent.com/Borlantrix/openclaw-channel-nextcompany/main/scripts/install.sh | bash

PLUGIN_DIR="$HOME/.openclaw/extensions/openclaw-channel-nextcompany"
REPO_URL="https://github.com/Borlantrix/openclaw-channel-nextcompany.git"
BRANCH="main"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  OpenClaw Channel NextCompany — Install/Update"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

if [ -d "$PLUGIN_DIR/.git" ]; then
  echo "✓ Plugin already installed — updating..."
  cd "$PLUGIN_DIR"
  
  # Stash any local changes
  if ! git diff-index --quiet HEAD --; then
    echo "  Stashing local changes..."
    git stash
  fi
  
  # Pull latest
  git pull origin "$BRANCH"
  UPDATE=true
else
  echo "✓ Installing plugin for the first time..."
  
  # Create parent directory if needed
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  
  # Clone
  git clone -b "$BRANCH" "$REPO_URL" "$PLUGIN_DIR"
  cd "$PLUGIN_DIR"
  UPDATE=false
fi

echo
echo "✓ Installing dependencies..."
npm install --silent

echo
echo "✓ Building plugin..."
npm run build --silent

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$UPDATE" = true ]; then
  echo "  ✅ Plugin updated successfully!"
else
  echo "  ✅ Plugin installed successfully!"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "Next steps:"
echo "  1. Restart OpenClaw gateway: openclaw gateway restart"
echo "  2. Verify status: openclaw status"
echo
