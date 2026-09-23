@echo off
title Strom Fire
color 0A

echo.
echo  ========================================
echo   Strom Fire - Anonymous Load Tester
echo  ========================================
echo.

echo [1/5] Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  OK: %NODE_VER%

echo.
echo [2/5] Checking port 8787...
netstat -ano | findstr ":8787 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo  Port 8787 in use — killing existing server...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787 " ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo  Cleared.
) else (
    echo  Port 8787 is free.
)

echo.
echo [3/5] Detecting Tor Browser...
set TOR_PORT=0
for /f "tokens=*" %%i in ('node check-tor.js') do set TOR_PORT=%%i

if "%TOR_PORT%"=="0" (
    echo  Tor: Not found - using direct connection
    set PROXY_URL=
) else (
    set PROXY_URL=socks5://127.0.0.1:%TOR_PORT%
    echo  Tor: Found on port %TOR_PORT%
)

echo.
echo [4/5] Detecting Tor Browser path...
set TOR_BROWSER_PATH=
node -e "var fs=require('fs');var paths=['C:/ProgramData/chocolatey/lib/tor-browser/tools/tor-browser/Browser/firefox.exe','C:/Users/'+process.env.USERNAME+'/Desktop/Tor Browser/Browser/firefox.exe','C:/Program Files/Tor Browser/Browser/firefox.exe'];var found=paths.find(function(p){try{fs.accessSync(p);return true}catch(e){return false}});if(found)console.log(found);else console.log('NOT_FOUND')" > "%TEMP%\tor_path.txt" 2>&1
set /p TOR_BROWSER_PATH=<"%TEMP%\tor_path.txt"
del "%TEMP%\tor_path.txt" >nul 2>&1

if "%TOR_BROWSER_PATH%"=="NOT_FOUND" (
    echo  Tor Browser not found in common locations
    set TOR_BROWSER_PATH=
) else (
    echo  Found: %TOR_BROWSER_PATH%
)

echo.
echo [5/5] Starting server...
start "Strom Fire" /B node server.js
timeout /t 3 /nobreak >nul

node -e "var h=require('http');h.get('http://127.0.0.1:8787/api/status',function(r){r.on('data',function(){});r.on('end',function(){console.log('OK')})}).on('error',function(){console.log('FAIL');process.exit(1)})"
if %errorlevel% neq 0 (
    echo  Server FAILED
    pause
    exit /b 1
)

echo.
echo  ========================================
echo   Strom Fire is running!
echo  ========================================
echo.
echo   Dashboard: http://127.0.0.1:8787
echo.
echo   Open in Chrome/Edge (NOT Tor Browser).
echo   Tor Browser is used as proxy only.
echo   Close this window anytime.
echo.

start http://127.0.0.1:8787
