#!/usr/bin/bash

nodever=`node -v`
major_version=$(echo "${nodever}" | cut -d'.' -f1 | tr -d 'v')

if [ "$major_version" -ge 20 ]; then
    echo "Node version check passed."
else
    echo "Node version check failed. Please install a version >= 20. If you haven't installed npm yet:"
    echo "  sudo apt install npm"
    echo "If you have an older version of node.js installed already:"
    echo "  sudo npm install 20"
    echo "  sudo npm use 20"
    exit 1
fi

if [ ! -d node_modules ]; then
    npm install
fi

# switch between a prod config and a dev config for testing
if [ "$1" = "dev" ]; then
  if [ -f config-dev.json ]; then
    cp config-dev.json config.json
  fi
else
  if [ -f config-prod.json ]; then
    cp config-prod.json config.json
  fi
fi

# npm run dev
npm run dev -- --force
