@echo off
REM ============================================================
REM Strom Fire Anonymous Launcher (Windows)
REM ============================================================
REM Usage: start-anon.bat "https://your-target.com" [concurrency] [duration_sec]
REM Example: start-anon.bat "https://staging.example.com" 100 120
REM Duration 0 = unlimited (runs until stopped)
REM ============================================================

setlocal enabledelayedexpansion

set TARGET_URL=%~1
if "%TARGET_URL%"=="" (
    echo.
    echo Usage: start-anon.bat "https://your-target.com" [concurrency] [duration_sec]
    echo Example: start-anon.bat "https://staging.example.com" 100 120
    echo Duration 0 = unlimited (runs until stopped)
    echo.
    pause
    exit /b 1
)

set CONCURRENCY=%~2
if "%CONCURRENCY%"=="" set CONCURRENCY=50

set DURATION=%~3
if "%DURATION%"=="" set DURATION=0

set PROFILE=desktop-chrome
set JITTER=25

echo.
echo ============================================================
echo  Strom Fire Anonymous Launcher
echo ============================================================
echo Target:      %TARGET_URL%
echo Concurrency: %CONCURRENCY%
if "%DURATION%"=="0" (
    echo Duration:    UNLIMITED (stops when you press Ctrl+C)
) else (
    echo Duration:    %DURATION% sec
)
echo Profile:     %PROFILE%
echo Jitter:      %JITTER% ms
echo Proxy:       socks5://127.0.0.1:9150 or :9050 (Tor, auto-detected)
echo Auto-rotate: Enabled (switches IP when blocked)
echo ============================================================
echo.

REM 1. Check Tor (Tor Browser 9150, else system tor 9050) using check-tor.js
echo [1/6] Checking Tor on 127.0.0.1 (9150, then 9050)...
node check-tor.js > "%TEMP%\tor_check.txt" 2>&1
set /p TOR_PORT=<"%TEMP%\tor_check.txt"
del "%TEMP%\tor_check.txt" >nul 2>&1
if "%TOR_PORT%"=="0" (
    echo ERROR: No Tor SOCKS port reachable (tried 9150 and 9050).
    echo.
    echo To fix:
    echo   1. Open Tor Browser and click "Connect" (SOCKS 9150), OR
    echo      start system tor (SOCKS 9050)
    echo   2. Keep it running
    echo   3. Run this launcher again
    echo.
    pause
    exit /b 1
)
REM Derived control port follows the SOCKS port (9150/9151, 9050/9051), then
REM verified: mixed-pair hosts (e.g. SOCKS 9050 + control 9151) fall back to
REM whichever control port answers.
if "%TOR_PORT%"=="9050" (
    set TOR_CTRL_DERIVED=9051
    set TOR_CTRL_ALT=9151
) else (
    set TOR_CTRL_DERIVED=9151
    set TOR_CTRL_ALT=9051
)
node check-tor-control.js %TOR_CTRL_DERIVED% %TOR_CTRL_ALT% > "%TEMP%\tor_ctrl.txt" 2>&1
set /p TOR_CTRL=<"%TEMP%\tor_ctrl.txt"
del "%TEMP%\tor_ctrl.txt" >nul 2>&1
if "%TOR_CTRL%"=="" set TOR_CTRL=%TOR_CTRL_DERIVED%
if "%TOR_PORT%"=="9050" (
    echo Tor: system tor detected on port 9050 ^(control %TOR_CTRL%^)
) else (
    echo Tor Browser: Connected on port %TOR_PORT% ^(control %TOR_CTRL%^)
)
if not "%TOR_CTRL%"=="%TOR_CTRL_DERIVED%" echo NOTE: control %TOR_CTRL_DERIVED% refused, but %TOR_CTRL% answers - using %TOR_CTRL% ^(mixed Tor pair^).
if %CONCURRENCY% GTR 20 echo WARNING: concurrency %CONCURRENCY% is far past what one Tor circuit handles (~20). Expect queueing/timeouts. Use 20 or less for Tor runs.

REM 2. Start Strom Fire server (ENABLE_EVASION=1 allows Tor NEWNYM rotation;
REM without it every rotation fails with "Tor rotation disabled")
echo [2/6] Starting Strom Fire server...
set ENABLE_EVASION=1
start "Strom Fire" /B node server.js
timeout /t 3 /nobreak >nul

REM Capture server PID for cleanup
for /f "tokens=2 delims=," %%i in ('wmic process where "commandline like '%%server.js%%' and name='node.exe'" get processid /format:csv 2^>nul ^| find ","') do set SERVER_PID=%%i

REM 3. Verify server is running
echo [3/6] Verifying server...
node -e "const h=require('http');h.get('http://127.0.0.1:8787/api/status',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('OK'))}).on('error',()=>{console.log('FAIL');process.exit(1)})"
if %errorlevel% neq 0 (
    echo ERROR: Strom Fire server failed to start
    pause
    exit /b 1
)
echo Server: Running on http://127.0.0.1:8787

REM 3b. Sign in when the server requires it (no-op when auth is off:
REM /api/login answers 400 and no cookie is stored)
set LS_COOKIE=
node -e "var h=require('http');var data=JSON.stringify({username:process.env.STROMFIRE_USER||'admin',password:process.env.STROMFIRE_PASSWORD||''});var req=h.request({hostname:'127.0.0.1',port:8787,path:'/api/login',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},function(r){var d='';r.on('data',function(c){d+=c});r.on('end',function(){var sc=r.headers['set-cookie'];if(r.statusCode===200&&sc&&sc.length)console.log(sc[0].split(';')[0])})});req.on('error',function(){});req.write(data);req.end()" > "%TEMP%\ls_cookie.txt" 2>&1
set /p LS_COOKIE=<"%TEMP%\ls_cookie.txt"
del "%TEMP%\ls_cookie.txt" >nul 2>&1
if defined LS_COOKIE echo Signed in, session ready.

REM 4+5. Build config from environment and start test via API.
REM (Config is assembled inside node from env vars: embedding JSON with
REM nested double-quotes directly on the cmd line would break parsing, and
REM a URL containing & would split the command.)
echo [4/6] Building test config...
echo [5/6] Starting anonymous load test...
node -e "const h=require('http');const cfg={url:process.env.TARGET_URL,mode:'load',concurrency:parseInt(process.env.CONCURRENCY)||50,durationSec:parseInt(process.env.DURATION)||0,rampUpSec:10,proxy:'socks5://127.0.0.1:'+process.env.TOR_PORT,headerProfile:process.env.PROFILE,rotateHeaders:true,requestJitterMs:parseInt(process.env.JITTER)||25,isolateCookies:true,simulateUserSession:false,httpVersion:'1.1',trackPhases:true,pacing:'standard',timeoutMs:30000,tlsVerify:true,confirm:true,autoRotate:true,torControlPort:parseInt(process.env.TOR_CTRL)||9151,blockThresholdPct:70,abortOnErrorRatePct:50,thresholds:{maxErrorRatePct:5,maxP95Ms:2000,minRps:0}};const data=JSON.stringify(cfg);const req=h.request({hostname:'127.0.0.1',port:8787,path:'/api/start',method:'POST',headers:(()=>{var hd={'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)};if(process.env.LS_COOKIE)hd.Cookie=process.env.LS_COOKIE;return hd})()},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('Test started:',d))});req.on('error',e=>console.error('Error:',e.message));req.write(data);req.end()"

REM 6. Poll for completion
echo [6/6] Running test... (auto-rotation enabled)
echo.
echo ============================================================
echo  LIVE STATUS
echo ============================================================
:POLL
timeout /t 5 /nobreak >nul
node -e "const h=require('http');h.get({hostname:'127.0.0.1',port:8787,path:'/api/status',headers:(()=>{var hd={};if(process.env.LS_COOKIE)hd.Cookie=process.env.LS_COOKIE;return hd})()},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);const state=j.engineState||'?';const rps=j.rps||j.attemptedRps||0;const users=j.activeWorkers||0;const err=j.errRate?((j.errRate)*100).toFixed(1):'0';const rot=j.rotationCount||0;console.log('[STATUS] State:'+state+' | RPS:'+rps+' | Users:'+users+' | Errors:'+err+'%% | Rotations:'+rot);if(state==='finished'||state==='error'){process.exit(0)}}catch(e){console.log('Waiting...')}})}).on('error',()=>console.log('Connection lost...'))"

REM Check if finished
if %errorlevel% equ 0 goto DONE
goto POLL

:DONE
echo.
echo ============================================================
echo  TEST COMPLETE
echo ============================================================
echo.

REM Get final report
echo Fetching final report...
node -e "const h=require('http');h.get({hostname:'127.0.0.1',port:8787,path:'/api/report',headers:(()=>{var hd={};if(process.env.LS_COOKIE)hd.Cookie=process.env.LS_COOKIE;return hd})()},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const w=JSON.parse(d);const j=w.report||w;console.log('Status:',j.result?.status||'unknown');console.log('Headline:',j.result?.headline||'');console.log('Requests:',j.metrics?.attempted||0);console.log('OK:',j.metrics?.ok||0);console.log('Failed:',j.metrics?.failed||0);console.log('RPS:',j.metrics?(j.metrics.rps||j.metrics.attemptedRps||0):0);console.log('p95:',j.metrics?.latency?.p95?.toFixed(0)||0,'ms');if(j.rotationCount){console.log('IP Rotations:',j.rotationCount)}if(j.result?.reasons){console.log('Reasons:');j.result.reasons.forEach(x=>console.log('  - '+x))}if(j.result?.recommendations){console.log('Next steps:');j.result.recommendations.forEach(x=>console.log('  - '+x))}}catch(e){console.log('Report available at http://127.0.0.1:8787')}})})"

REM Save report to file
set TIMESTAMP=%date:~-4,4%%date:~-7,2%%date:~-10,2%-%time:~0,2%%time:~3,2%%time:~6,2%
set TIMESTAMP=%TIMESTAMP: =0%
node -e "const h=require('http');const fs=require('fs');h.get({hostname:'127.0.0.1',port:8787,path:'/api/report',headers:(()=>{var hd={};if(process.env.LS_COOKIE)hd.Cookie=process.env.LS_COOKIE;return hd})()},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{fs.writeFileSync('anon-report-%TIMESTAMP%.json',d);console.log('Report saved: anon-report-%TIMESTAMP%.json')})})"

echo.
echo Dashboard still running at: http://127.0.0.1:8787
echo Press any key to stop server and exit...
pause >nul

REM Stop server
if defined SERVER_PID (
    taskkill /PID %SERVER_PID% /F >nul 2>&1
) else (
    taskkill /IM node.exe /F >nul 2>&1
)
echo Server stopped.
