#!/usr/bin/env bash
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
R="$HOME/file-memory-real-repos/repos"
for repo in axios-axios prettier-prettier pytest-dev-pytest; do
  echo "=== $repo ==="
  node -e "const s=require('$R/$repo/package.json').scripts||{}; for(const k of Object.keys(s)) if(/test|mocha|vitest|jest/i.test(k)||/mocha|vitest|jest/i.test(s[k])) console.log('  '+k+' = '+s[k])" 2>&1 | head -8
  echo "  config files:"; ls "$R/$repo" 2>/dev/null | grep -iE "mocharc|vitest.config|jest.config|\.mocharc" | sed 's/^/    /'
done
