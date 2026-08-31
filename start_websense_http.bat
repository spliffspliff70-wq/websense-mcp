@echo off
setlocal
set PORT=38401
cd /d "%~dp0"

:: Check if already running on HTTP port 9222
powershell -Command "try { $c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 9222); $c.Close(); exit 0 } catch { exit 1 }"
if %ERRORLEVEL% == 0 (
    echo WebSense HTTP server already running on port 9222 >> "%~dp0websense_http.log"
    exit 0
)

node src/server.js --http --http-port 9222 >> "%~dp0websense_http.log" 2>&1
