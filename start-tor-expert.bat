@echo off
REM Strom Fire Tor Expert Bundle starter (full-auto rotation).
REM 1. Download "Tor Expert Bundle for Windows" from torproject.org/download
REM 2. Extract it so that tor.exe is at  %USERPROFILE%\tor\tor.exe
REM 3. Double-click this file.
SETLOCAL
set BUNDLE_DIR=%USERPROFILE%\tor
set TOR_EXE=%BUNDLE_DIR%\tor.exe
if not exist "%TOR_EXE%" (
  echo [Strom Fire] tor.exe not found at "%TOR_EXE%"
  echo   Download the Tor Expert Bundle for Windows from https://www.torproject.org/download
  echo   and extract it so tor.exe lands in %%USERPROFILE%%\tor\
  pause
  exit /b 1
)
if not exist "%BUNDLE_DIR%\tor-data" mkdir "%BUNDLE_DIR%\tor-data"
REM Generate torrc with absolute DataDirectory (relative paths resolve to the
REM caller's working directory, which is wrong when double-clicked from Explorer).
(
  echo # Strom Fire Tor Expert Bundle config - full-auto circuit rotation.
  echo # WARNING: unauthenticated control port. Localhost-only - never expose 9050/9051.
  echo SocksPort 9050
  echo ControlPort 9051
  echo CookieAuthentication 0
  echo # Faster circuit turnover for rotation testing (Strom Fire rotates on
  echo # demand with NEWNYM; these only affect Tor's own background rotation).
  echo MaxCircuitDirtiness 60
  echo NewCircuitPeriod 30
  echo DataDirectory %BUNDLE_DIR%\tor-data
) > "%BUNDLE_DIR%\torrc"
echo [Strom Fire] Starting Tor Expert Bundle (SOCKS 9050, control 9051)...
echo   First bootstrap takes ~30-60s. Afterwards run:  node check-tor.js   (expect 9050)
echo   Then start Strom Fire with:  set ENABLE_EVASION=1 ^&^& node server.js
start "Tor Expert Bundle" "%TOR_EXE%" -f "%BUNDLE_DIR%\torrc"
echo [Strom Fire] Tor launched in a new window. Keep it open.
pause
