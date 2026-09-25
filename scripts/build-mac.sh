#!/usr/bin/env bash
# Сборка NetPulse для macOS: универсальный NetPulse.app + .dmg (Apple Silicon и Intel).
# Всё необходимое (Command Line Tools, Node.js, Rust) скрипт ставит сам.
# По умолчанию готовое приложение сразу копируется в /Applications и запускается.
#   ./scripts/build-mac.sh                       — собрать и установить в /Applications
#   ./scripts/build-mac.sh --no-install          — только собрать
#   ./scripts/build-mac.sh --release             — собрать и опубликовать обновление в GitHub Releases
#   ./scripts/build-mac.sh --release --repo владелец/репозиторий --notes "что нового"
#   ./scripts/build-mac.sh --windows-only        — только подписать и опубликовать готовый Windows-установщик
#                                                   из dist/windows (та же версия, без пересборки Mac)
# Если в dist/windows лежит NetPulse_<версия>_x64-setup.exe, --release публикует и его.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$HOME/.netpulse-build"
INSTALL=1
RELEASE=0
REPO=""
NOTES=""
WIN_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-install) INSTALL=0 ;;
    --release) RELEASE=1 ;;
    --windows-only) WIN_ONLY=1; RELEASE=1; INSTALL=0 ;;
    --repo) REPO="${2:-}"; shift ;;
    --notes) NOTES="${2:-}"; shift ;;
    *) echo "Неизвестный параметр: $1"; exit 2 ;;
  esac
  shift
done
mkdir -p "$TOOLS"
# Репозиторий обновлений встраивается в программу: app/src-tauri/update-repo.txt.
REPO_FILE="$ROOT/app/src-tauri/update-repo.txt"
if [ -n "$REPO" ]; then printf '%s' "$REPO" > "$REPO_FILE"; fi
[ -z "$REPO" ] && [ -f "$REPO_FILE" ] && REPO="$(tr -d '[:space:]' < "$REPO_FILE")"

step() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

# ---------- 1. Command Line Tools (компилятор)
if ! xcrun --find clang >/dev/null 2>&1; then
  step "Устанавливаю Command Line Tools — в появившемся окне нажмите «Установить»"
  xcode-select --install >/dev/null 2>&1 || true
  printf 'Жду окончания установки'
  until xcrun --find clang >/dev/null 2>&1; do printf '.'; sleep 10; done
  echo " готово"
fi

# ---------- 2. Node.js 20+
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
if [ -d "$TOOLS" ]; then
  for d in "$TOOLS"/node-*/bin; do [ -d "$d" ] && export PATH="$d:$PATH"; done
fi
if ! node_ok; then
  step "Устанавливаю Node.js (в $TOOLS, без прав администратора)"
  case "$(uname -m)" in arm64) NARCH=arm64 ;; *) NARCH=x64 ;; esac
  BASE="https://nodejs.org/dist/latest-v22.x"
  FILE="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '{print $2}' | grep "darwin-$NARCH.tar.gz$" | head -1)"
  [ -n "$FILE" ] || fail "не удалось получить список версий Node.js (проверьте интернет)"
  mkdir -p "$TOOLS"
  curl -fL --progress-bar "$BASE/$FILE" | tar -xz -C "$TOOLS"
  export PATH="$TOOLS/${FILE%.tar.gz}/bin:$PATH"
  node_ok || fail "Node.js не установился"
fi
echo "Node.js $(node --version)"

# ---------- 3. Rust через rustup (Rust из Homebrew не умеет universal-сборку)
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
if ! command -v rustup >/dev/null 2>&1; then
  step "Устанавливаю Rust (rustup)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  source "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
rustc --version

# ---------- 4. Сборка
cd "$ROOT/app"
if [ "$WIN_ONLY" = 0 ] || [ ! -d node_modules ]; then
  [ "$WIN_ONLY" = 0 ] && step "Собираю NetPulse (первый раз 5–15 минут)"
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
fi
# .dmg собираем отдельно (шаг 4б): штатный способ Tauri управляет Finder через AppleScript
# и падает, если открыт старый установщик или у Терминала нет доступа к Finder.

# Ключ подписи обновлений: создаётся один раз и хранится только на этом Mac.
KEY="$TOOLS/updater.key"
if [ ! -f "$KEY" ] || [ ! -f "$KEY.pub" ]; then
  step "Создаю ключ подписи обновлений ($KEY)"
  npx tauri signer generate --ci -p "" -w "$KEY" -f >/dev/null
  echo "Сохраните копию $KEY в надёжном месте: без него нельзя выпускать обновления."
fi
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
export NETPULSE_UPDATER_PUBKEY="$(cat "$KEY.pub")"
# Токен для обновлений больше не нужен: репозиторий релизов читается анонимно.
unset NETPULSE_UPDATE_TOKEN
# Подпись — ad-hoc (без Apple ID), архив для автообновления создаётся рядом с .app.
# Публичный ключ нужен и сборщику (проверка подписи архива), и программе.
UPD_CONF="$TOOLS/updater.conf.json"
PUB="$NETPULSE_UPDATER_PUBKEY" node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: process.env.PUB, endpoints: [] } } }))' "$UPD_CONF"
OUT="$ROOT/target/universal-apple-darwin/release/bundle"
APP="$OUT/macos/NetPulse.app"
VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
DMG=""
if [ "$WIN_ONLY" = 0 ]; then
npm run tauri build -- --target universal-apple-darwin --bundles app --config "$UPD_CONF"
[ -d "$APP" ] || fail "сборка не создала NetPulse.app"

# ---------- 4б. Установщик .dmg с оформлением
step "Собираю установщик .dmg"
mkdir -p "$OUT/dmg"
DMG="$OUT/dmg/NetPulse_${VERSION}_universal.dmg"
rm -f "$OUT"/dmg/*.dmg
# Отключаем ранее открытые установщики NetPulse — иначе образ не собрать.
for v in /Volumes/NetPulse*; do
  [ -d "$v" ] && hdiutil detach "$v" -force >/dev/null 2>&1 || true
done
VENV="$TOOLS/dmg-venv"
if [ ! -x "$VENV/bin/dmgbuild" ]; then
  rm -rf "$VENV"
  python3 -m venv "$VENV" && "$VENV/bin/pip" install -q --upgrade pip && "$VENV/bin/pip" install -q dmgbuild || true
fi
if [ -x "$VENV/bin/dmgbuild" ] && "$VENV/bin/dmgbuild" -s "$ROOT/scripts/dmg_settings.py" \
    -D app="$APP" -D bg="$ROOT/app/src-tauri/dmg/background.png" "NetPulse" "$DMG"; then
  echo "Установщик: $DMG"
else
  echo "Не удалось оформить .dmg — собираю простой образ без фона"
  TMPD="$(mktemp -d)"
  ditto "$APP" "$TMPD/NetPulse.app"
  ln -s /Applications "$TMPD/Applications"
  hdiutil create -volname "NetPulse" -srcfolder "$TMPD" -ov -format UDZO "$DMG" >/dev/null || DMG=""
  rm -rf "$TMPD"
fi
fi

# ---------- 4в. Публикация обновления в GitHub Releases
if [ "$RELEASE" = 1 ]; then
  step "Публикую версию $VERSION в GitHub Releases"
  [ -n "$REPO" ] || fail "укажите репозиторий: ./scripts/build-mac.sh --release --repo владелец/репозиторий"
  TAR="$OUT/macos/NetPulse.app.tar.gz"
  WIN_DIR="$ROOT/dist/windows"
  WIN_EXE="$WIN_DIR/NetPulse_${VERSION}_x64-setup.exe"
  WIN_PORT="$WIN_DIR/NetPulse_${VERSION}_portable.exe"
  if [ "$WIN_ONLY" = 1 ]; then
    [ -f "$WIN_EXE" ] || fail "не найден $WIN_EXE"
  else
    [ -f "$TAR" ] && [ -f "$TAR.sig" ] || fail "не найден архив обновления $TAR (.sig)"
  fi
  # GitHub CLI — ставим сами, если его нет.
  if ! command -v gh >/dev/null 2>&1; then
    if [ ! -x "$TOOLS/gh/bin/gh" ]; then
      echo "Устанавливаю GitHub CLI в $TOOLS/gh"
      GH_TAG="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name.replace(/^v/,"")))')"
      TMPZ="$(mktemp -d)"
      curl -fsSL -o "$TMPZ/gh.zip" "https://github.com/cli/cli/releases/download/v${GH_TAG}/gh_${GH_TAG}_macOS_universal.zip"
      unzip -q "$TMPZ/gh.zip" -d "$TMPZ"
      rm -rf "$TOOLS/gh" && mv "$TMPZ"/gh_*_macOS_universal "$TOOLS/gh"
      rm -rf "$TMPZ"
    fi
    export PATH="$TOOLS/gh/bin:$PATH"
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "Нужно один раз войти в GitHub (откроется браузер):"
    gh auth login --hostname github.com --git-protocol https --web
  fi
  gh auth setup-git >/dev/null 2>&1 || true

  REL="$ROOT/dist/release-$VERSION"
  rm -rf "$REL" && mkdir -p "$REL"
  ASSET="NetPulse_${VERSION}_universal.app.tar.gz"
  if [ "$WIN_ONLY" = 0 ]; then
    cp "$TAR" "$REL/$ASSET"
    [ -n "$DMG" ] && cp "$DMG" "$REL/"
  fi
  # Windows: установщик подписывается тем же ключом и служит файлом автообновления.
  WIN_SIG=""
  if [ -f "$WIN_EXE" ]; then
    step "Подписываю Windows-установщик"
    rm -f "$WIN_EXE.sig"
    # Ключ уже в TAURI_SIGNING_PRIVATE_KEY (-f вместе с ним нельзя).
    npx tauri signer sign "$WIN_EXE" >/dev/null
    [ -f "$WIN_EXE.sig" ] || fail "не удалось подписать $WIN_EXE"
    WIN_SIG="$(cat "$WIN_EXE.sig")"
    cp "$WIN_EXE" "$REL/"
    [ -f "$WIN_PORT" ] && cp "$WIN_PORT" "$REL/"
  fi
  [ -n "$NOTES" ] || NOTES="NetPulse $VERSION"
  # 1) Файлы релиза.
  if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "v$VERSION" "$REL"/* --repo "$REPO" --clobber
  else
    [ "$WIN_ONLY" = 0 ] || fail "релиза v$VERSION ещё нет: сначала выпустите Mac-версию (--release)"
    gh release create "v$VERSION" "$REL"/* --repo "$REPO" --title "NetPulse $VERSION" --notes "$NOTES" --latest
  fi
  # 2) Описание версии: прямые публичные ссылки на файлы релиза — скачиваются
  #    без токена и без входа в GitHub, поэтому обновление работает на любом компьютере.
  asset_url() {
    local url="https://github.com/$REPO/releases/download/v$VERSION/$1" i
    # Убеждаемся, что файл действительно доступен всем без входа в GitHub,
    # иначе обновление не скачается. Сразу после выпуска файл появляется не мгновенно.
    for i in 1 2 3 4 5; do
      if curl -fsL -r 0-0 -o /dev/null --max-time 60 "$url"; then echo "$url"; return 0; fi
      sleep 3
    done
    return 1
  }
  MAC_URL=""; MAC_SIG=""
  if [ "$WIN_ONLY" = 0 ]; then
    MAC_URL="$(asset_url "$ASSET")" || true
    [ -n "$MAC_URL" ] || fail "не удалось получить ссылку на архив обновления в релизе"
    MAC_SIG="$(cat "$TAR.sig")"
  fi
  WIN_URL=""
  if [ -n "$WIN_SIG" ]; then
    WIN_URL="$(asset_url "$(basename "$WIN_EXE")")" || true
    [ -n "$WIN_URL" ] || fail "не удалось получить ссылку на Windows-установщик в релизе"
  fi
  mkdir -p "$ROOT/updates"
  # Записи другой платформы (например, Mac при --windows-only) сохраняются, если версия та же.
  MAC_SIG="$MAC_SIG" MAC_URL="$MAC_URL" WIN_SIG="$WIN_SIG" WIN_URL="$WIN_URL" VERSION="$VERSION" NOTES="$NOTES" node -e '
    const fs = require("fs"); const e = process.env; const file = process.argv[1];
    let old = {}; try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const same = old.version === e.VERSION;
    const platforms = same ? { ...(old.platforms || {}) } : {};
    if (e.MAC_URL) { const p = { signature: e.MAC_SIG, url: e.MAC_URL }; Object.assign(platforms, { "darwin-aarch64": p, "darwin-x86_64": p, "darwin-universal": p }); }
    if (e.WIN_URL) platforms["windows-x86_64"] = { signature: e.WIN_SIG, url: e.WIN_URL };
    const j = { version: e.VERSION, notes: same && !e.MAC_URL ? old.notes : e.NOTES, pub_date: new Date().toISOString(), platforms };
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  ' "$ROOT/updates/latest.json"
  gh release upload "v$VERSION" "$ROOT/updates/latest.json" --repo "$REPO" --clobber
  # Исходники — в репозиторий (если папка подключена к GitHub).
  if git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
    step "Отправляю исходники в GitHub"
    GH_LOGIN="$(gh api user -q .login 2>/dev/null || echo netpulse)"
    git -C "$ROOT" config user.name >/dev/null 2>&1 || git -C "$ROOT" config user.name "$GH_LOGIN"
    git -C "$ROOT" config user.email >/dev/null 2>&1 || git -C "$ROOT" config user.email "$GH_LOGIN@users.noreply.github.com"
    git -C "$ROOT" add -A
    git -C "$ROOT" commit -q -m "NetPulse $VERSION" || echo "Новых изменений в исходниках нет"
    BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
    git -C "$ROOT" push -u origin "$BRANCH"
  fi
  echo "Опубликовано: https://github.com/$REPO/releases/tag/v$VERSION"
  echo "Установленные NetPulse сами предложат обновиться до $VERSION."
fi

# ---------- 5. Установка в /Applications
if [ "$INSTALL" = 1 ]; then
  step "Устанавливаю в /Applications"
  osascript -e 'quit app "NetPulse"' >/dev/null 2>&1 || true
  sleep 1
  rm -rf "/Applications/NetPulse.app"
  ditto "$APP" "/Applications/NetPulse.app"
  xattr -dr com.apple.quarantine "/Applications/NetPulse.app" 2>/dev/null || true
  open "/Applications/NetPulse.app"
fi

step "Готово"
[ "$WIN_ONLY" = 0 ] && echo "Приложение: $APP"
[ -n "$DMG" ] && echo "Установщик для других Mac: $DMG"
[ "$WIN_ONLY" = 1 ] && echo "Windows-версия $VERSION опубликована."
[ "$INSTALL" = 1 ] && echo "NetPulse установлен в /Applications и запущен."
exit 0
