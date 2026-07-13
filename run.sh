#!/usr/bin/bash

reqver=22

# If nvm is available, activate the required Node version so we don't run
# under whatever node the current shell happens to have on its PATH.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    nvm use ${reqver} >/dev/null 2>&1 || nvm use default >/dev/null 2>&1
fi

nodever=`node -v`
major_version=$(echo "${nodever}" | cut -d'.' -f1 | tr -d 'v')

if [ "$major_version" -ge ${reqver} ]; then
    echo "Node version check passed (node ${nodever})."
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

./build.sh

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
