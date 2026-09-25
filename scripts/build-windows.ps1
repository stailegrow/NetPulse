# Сборка NetPulse для Windows: установщик NetPulse_*_x64-setup.exe + портативный netpulse.exe.
# Всё необходимое (Visual Studio Build Tools, Rust, Node.js) скрипт ставит сам через winget.
# Запуск (PowerShell):  powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Step($t) { Write-Host "`n> $t" -ForegroundColor Green }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.cargo\bin"
}
function Need-Winget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Не найден winget. Установите «Установщик приложений» (App Installer) из Microsoft Store и запустите скрипт снова."
  }
}

# 1. Visual Studio Build Tools (компилятор C++ и Windows SDK)
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVC = (Test-Path $vswhere) -and (& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if (-not $hasVC) {
  Need-Winget
  Step "Устанавливаю Visual Studio Build Tools (10–20 минут)"
  winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements `
    --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
}

# 2. Node.js
Refresh-Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Need-Winget
  Step "Устанавливаю Node.js"
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Refresh-Path
}

# 3. Rust
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Step "Устанавливаю Rust"
  $rustup = Join-Path $env:TEMP "rustup-init.exe"
  Invoke-WebRequest "https://win.rustup.rs/x86_64" -OutFile $rustup
  & $rustup -y --default-toolchain stable --profile minimal
  Refresh-Path
}

# 4. Сборка
Step "Собираю NetPulse"
Set-Location (Join-Path $Root "app")
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { npm install --no-audit --no-fund }
npm run tauri build -- --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "Сборка завершилась с ошибкой" }

Step "Готово"
Get-ChildItem "$Root\target\release\bundle\nsis\*.exe", "$Root\target\release\netpulse.exe" | ForEach-Object { $_.FullName }
