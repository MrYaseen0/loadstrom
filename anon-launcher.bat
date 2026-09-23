@echo off
REM ============================================================
REM Strom Fire Anonymous Launcher (Windows)
REM ============================================================
REM Usage: anon-launcher.bat "https://target.com" [concurrency] [duration] [proxy_list_file]
REM Example: anon-launcher.bat "https://staging.example.com" 100 120 proxies.txt
REM Duration 0 = unlimited (runs until stopped)
REM ============================================================

setlocal enabledelayedexpansion

set TARGET_URL=%~1
if "%TARGET_URL%"=="" (
    echo.
    echo Usage: anon-launcher.bat "https://target.com" [concurrency] [duration] [proxy_list_file]
    echo.
    echo   proxy_list_file = text file with one proxy per line
    echo     Example: proxies.txt containing:
    echo       socks5://127.0.0.1:9150
    echo       http://user:pass@proxy.example.com:8080
    echo.
    echo Duration 0 = unlimited (runs until stopped)
    pause
    exit /b 1
)

set CONCURRENCY=%~2
if "%CONCURRENCY%"=="" set CONCURRENCY=50

set DURATION=%~3
if "%DURATION%"=="" set DURATION=0

set PROXY_FILE=%~4

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

if defined PROXY_FILE (
    echo Proxy file:  %PROXY_FILE%
) else (
    echo Proxy:       socks5://127.0.0.1:9150 or :9050 (Tor, auto-detected)
)
echo Auto-rotate: Enabled (switches IP when blocked)
echo ============================================================
echo.

REM 1. Check Tor Browser
echo [1/7] Checking Tor on 127.0.0.1 (9150, then 9050)...
node check-tor.js > "%TEMP%\tor_check.txt" 2>&1
set /p TOR_PORT=<"%TEMP%\tor_check.txt"
del "%TEMP%\tor_check.txt" >nul 2>&1

if "%TOR_PORT%"=="0" (
    echo Tor Browser: Not detected
    if not defined PROXY_FILE (
        echo ERROR: No Tor Browser and no proxy file provided.
        echo Either start Tor Browser or provide a proxy list file.
        pause
        exit /b 1
    )
) else (
    if "%TOR_PORT%"=="9050" (
        echo Tor: system tor detected on port 9050 ^(control 9051^)
    ) else (
        echo Tor Browser: Connected on port %TOR_PORT% ^(control 9151^)
    )
    if %CONCURRENCY% GTR 20 echo WARNING: concurrency %CONCURRENCY% is far past what one Tor circuit handles (~20). Expect queueing/timeouts. Use 20 or less for Tor runs.
)

REM 2. Start Strom Fire server (ENABLE_EVASION=1 allows Tor NEWNYM rotation;
REM without it every rotation fails with "Tor rotation disabled")
echo [2/7] Starting Strom Fire server...
set ENABLE_EVASION=1
start "Strom Fire" /B node server.js
timeout /t 3 /nobreak >nul

REM Capture server PID
for /f "tokens=2 delims=," %%i in ('wmic process where "commandline like '%%server.js%%' and name='node.exe'" get processid /format:csv 2^>nul ^| find ","') do set SERVER_PID=%%i

REM 3. Verify server
echo [3/7] Verifying server...
node -e "var h=require('http');h.get('http://127.0.0.1:8787/api/status',function(r){r.on('data',function(){});r.on('end',function(){console.log('OK')})}).on('error',function(){console.log('FAIL');process.exit(1)})"
if %errorlevel% neq 0 (
    echo ERROR: Server failed to start
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

REM 4. Build proxy config
echo [4/7] Building config...
if defined PROXY_FILE (
    REM Normalize proxy list into a temp JSON file (kept as a file: proxy URLs
    REM contain characters that break if expanded onto the cmd line)
    echo Reading proxies from %PROXY_FILE%...
    set LS_PROXY_JSON=%TEMP%\ls_proxies.json
    node -e "var fs=require('fs');var lines=fs.readFileSync(process.env.PROXY_FILE,'utf8').split('\n').map(function(l){return l.trim()}).filter(function(l){return l&&!l.startsWith('#')});var proxies=lines.map(function(l){return l.startsWith('http')||l.startsWith('socks')?l:'http://'+l});fs.writeFileSync(process.env.LS_PROXY_JSON,JSON.stringify(proxies));console.log('Proxies loaded: '+proxies.length)"
    if !errorlevel! neq 0 (
        echo ERROR: Could not read proxy file %PROXY_FILE%
        pause
        exit /b 1
    )
) else (
    REM Derived control port follows the SOCKS port, then verified: mixed-pair
    REM hosts (e.g. SOCKS 9050 + control 9151) fall back to whichever answers.
    if "%TOR_PORT%"=="9050" (
        set TOR_CTRL_DERIVED=9051
        set TOR_CTRL_ALT=9151
    ) else (
        set TOR_CTRL_DERIVED=9151
        set TOR_CTRL_ALT=9051
    )
    node check-tor-control.js !TOR_CTRL_DERIVED! !TOR_CTRL_ALT! > "%TEMP%\tor_ctrl.txt" 2>&1
    set /p TOR_CTRL=<"%TEMP%\tor_ctrl.txt"
    del "%TEMP%\tor_ctrl.txt" >nul 2>&1
    if "!TOR_CTRL!"=="" set TOR_CTRL=!TOR_CTRL_DERIVED!
    if not "!TOR_CTRL!"=="!TOR_CTRL_DERIVED!" echo NOTE: control !TOR_CTRL_DERIVED! refused, but !TOR_CTRL! answers - using !TOR_CTRL! ^(mixed Tor pair^).
)

REM 5. Start test (config assembled inside node from env vars: embedding JSON
REM with nested double-quotes directly on the cmd line would break parsing)
echo [5/7] Starting load test...
node -e "var h=require('http');var fs=require('fs');var cfg={url:process.env.TARGET_URL,mode:'load',concurrency:parseInt(process.env.CONCURRENCY)||50,durationSec:parseInt(process.env.DURATION)||0,rampUpSec:10,headerProfile:process.env.PROFILE,rotateHeaders:true,requestJitterMs:parseInt(process.env.JITTER)||25,isolateCookies:true,simulateUserSession:false,httpVersion:'1.1',trackPhases:true,pacing:'standard',timeoutMs:15000,tlsVerify:true,confirm:true,autoRotate:true,blockThresholdPct:50,abortOnErrorRatePct:50,reuseConnections:true,thresholds:{maxErrorRatePct:100,maxP95Ms:10000,minRps:0}};if(process.env.PROXY_FILE){cfg.proxyList=JSON.parse(fs.readFileSync(process.env.LS_PROXY_JSON,'utf8'))}else{cfg.proxy='socks5://127.0.0.1:'+process.env.TOR_PORT;cfg.torControlPort=parseInt(process.env.TOR_CTRL)||9151;cfg.blockThresholdPct=70;cfg.timeoutMs=30000}var data=JSON.stringify(cfg);var req=h.request({hostname:'127.0.0.1',port:8787,path:'/api/start',method:'POST',headers:(()=>{var hd={'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)};if(process.env.LS_COOKIE)hd.Cookie=process.env.LS_COOKIE;return hd})()},function(r){var d='';r.on('data',function(c){d+=c});r.on('end',function(){console.log('Started:',d)})});req.on('error',function(e){console.error('Error:',e.message)});req.write(data);req.end()"

REM 6. Poll
echo [6/7] Running test... (auto-rotation enabled)
echo.
echo ============================================================
echo  LIVE STATUS
echo ============================================================
set ELAPSED=0
:POLL
timeout /t 5 /nobreak >nul
set /a ELAPSED=ELAPSED+5
node -e "var h=require('http');h.get({hostname:'127.0.0.1',port:8787,path:'/api/status',headers:(()=>{var hd={};if(process.env.LS_COOKIE)hd.Cookie=process.env.LS_COOKIE;return hd})()},function(r){var d='';r.on('data',function(c){d+=c});r.on('end',function(){try{var j=JSON.parse(d);var state=j.engineState||'?';var rps=j.rps||j.attemptedRps||0;var users=j.activeWorkers||0;var err=j.errRate?((j.errRate)*100).toFixed(1):'0';var rot=j.rotationCount||0;var elapsed=process.argv[1];console.log('[%TIME%] '+elapsed+'s | State:'+state+' | RPS:'+rps+' | Users:'+users+' | Errors:'+err+'%% | Rotations:'+rot);if(state==='finished'||state==='error'){process.exit(0)}}catch(e){console.log('Waiting...')}})}).on('error',function(){console.log('Connection lost...')})" %ELAPSED%

if %errorlevel% equ 0 goto DONE
goto POLL

:DONE
echo.
echo ============================================================
echo  TEST COMPLETE
echo ============================================================
echo.

REM 7. Get report
echo [7/7] Fetching report...
node -e "var h=require('http');h.get({hostname:'127.0.0.1',port:8787,path:'/api/report',headers:(()=>{var hd={};if(process.env.LS_COOKIE)hd.Cookie=process.env.LS_COOKIE;return hd})()},function(r){var d='';r.on('data',function(c){d+=c});r.on('end',function(){try{var w=JSON.parse(d);var j=w.report||w;console.log('Status:',j.result?j.result.status:'unknown');console.log('Headline:',j.result?j.result.headline:'');console.log('Requests:',j.metrics?j.metrics.attempted:0);console.log('OK:',j.metrics?j.metrics.ok:0);console.log('Failed:',j.metrics?j.metrics.failed:0);console.log('RPS:',j.metrics?(j.metrics.rps||j.metrics.attemptedRps||0):0);console.log('p95:',j.metrics&&j.metrics.latency?j.metrics.latency.p95.toFixed(0):0,'ms');if(j.rotationCount){console.log('IP Rotations:',j.rotationCount)}if(j.result&&j.result.reasons){console.log('Reasons:');j.result.reasons.forEach(function(x){console.log('  - '+x)})}if(j.result&&j.result.recommendations){console.log('Next steps:');j.result.recommendations.forEach(function(x){console.log('  - '+x)})}}catch(e){console.log('Report available at http://127.0.0.1:8787')}})})"

REM Save report
set TIMESTAMP=%date:~-4,4%%date:~-7,2%%date:~-10,2%-%time:~0,2%%time:~3,2%%time:~6,2%
set TIMESTAMP=%TIMESTAMP: =0%
node -e "var h=require('http');var fs=require('fs');h.get({hostname:'127.0.0.1',port:8787,path:'/api/report',headers:(()=>{var hd={};if(process.env.LS_COOKIE)hd.Cookie=process.env.LS_COOKIE;return hd})()},function(r){var d='';r.on('data',function(c){d+=c});r.on('end',function(){fs.writeFileSync('anon-report-%TIMESTAMP%.json',d);console.log('Report saved: anon-report-%TIMESTAMP%.json')})})"

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
