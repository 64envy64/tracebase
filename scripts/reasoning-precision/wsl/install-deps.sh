#!/usr/bin/env bash
# Idempotent dependency install for the capture-run repos (sudo-less: nvm/uv/
# corepack). Verified repos first (mathjs, rich, zod, black) so the run path is
# ready soonest; supply repos (axios, prettier, pytest) after. Recipe verbatim
# from the file-memory pilot's wsl-setup-and-smoke{,-replacements}.sh.
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@10.12.1 --activate >/dev/null 2>&1 || true
corepack prepare yarn@stable --activate >/dev/null 2>&1 || true

REPOS="$HOME/file-memory-real-repos/repos"
LOG="$HOME/file-memory-real-repos/results/install-deps.log"
: > "$LOG"
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

install_repo(){
  local dir="$1" marker="$2" cmd="$3" to="$4"
  local p="$REPOS/$dir"
  if [ ! -d "$p" ]; then log "MISSING $dir — skip"; return; fi
  if [ -e "$p/$marker" ]; then log "SKIP $dir (deps present: $marker)"; return; fi
  log "INSTALL $dir : $cmd"
  local t0=$(date +%s)
  ( cd "$p" && timeout "${to}s" bash -c "$cmd" ) >>"$LOG" 2>&1
  local ec=$?
  log "DONE  $dir exit=$ec elapsed=$(( $(date +%s) - t0 ))s"
}

# --- verified repos (needed to RUN) ---
install_repo josdejong-mathjs node_modules "npm install --no-audit --no-fund" 600
install_repo Textualize-rich   .venv "uv venv .venv --seed --quiet && .venv/bin/pip install --quiet -e . pytest pytest-cov attrs attr hypothesis pytest-mock" 600
install_repo colinhacks-zod    node_modules "pnpm install --frozen-lockfile=false" 900
install_repo psf-black         .venv "uv venv .venv --seed --quiet && .venv/bin/pip install --quiet -e '.[d]' 'pytest>=8' pytest-mock pytest-cov 'click>=8.2'" 600
# --- supply repos (needed to box-4c the 69 candidates) ---
install_repo axios-axios       node_modules "npm install --no-audit --no-fund" 600
install_repo prettier-prettier node_modules "yarn install" 900
install_repo pytest-dev-pytest .venv "uv venv .venv --seed --quiet && .venv/bin/pip install --quiet -e '.[testing]' attrs attr hypothesis pytest-mock pytest-xdist pygments" 600

log "ALL_DEPS_DONE"
shopt -s nullglob
echo "=== final deps inventory ===" | tee -a "$LOG"
for d in "$REPOS"/*/; do n=$(basename "$d"); nm=""; [ -d "$d/node_modules" ]&&nm="$nm node_modules"; [ -d "$d/.venv" ]&&nm="$nm .venv"; printf "  %-22s [%s]\n" "$n" "$nm" | tee -a "$LOG"; done
