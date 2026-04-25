#!/usr/bin/bash

reqver=20
nodever=`node -v`
major_version=$(echo "${nodever}" | cut -d'.' -f1 | tr -d 'v')

if [ "$major_version" -ge ${reqver} ]; then
    echo "Node version check passed."
else
    echo "Node version check failed. Please install a version >= ${reqver}. If you haven't installed npm yet:"
    echo "  sudo apt install npm"
    echo "If you have an older version of node.js installed already:"
    echo "  # make sure nvm is installed and available:"
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
    echo "  . ~/.bashrc"
    echo "  # install node ${reqver} and activate it"
    echo "  sudo nvm install ${reqver}"
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
