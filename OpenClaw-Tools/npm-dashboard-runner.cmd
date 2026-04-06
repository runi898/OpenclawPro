@echo off
setlocal EnableExtensions
chcp 65001 >nul

if defined OPENCLAW_PM2_APP_NAME (
  set "APP_NAME=%OPENCLAW_PM2_APP_NAME%"
) else (
  set "APP_NAME=openclaw-gateway"
)

set "CONFIG_PATH="
if defined OPENCLAW_PM2_CONFIG_PATH (
  if exist "%OPENCLAW_PM2_CONFIG_PATH%" (
    set "CONFIG_PATH=%OPENCLAW_PM2_CONFIG_PATH%"
  )
) 
if not defined CONFIG_PATH (
  call :ResolveConfigPath
)

set "SERVICE_DIR="
if defined CONFIG_PATH (
  for %%I in ("%CONFIG_PATH%") do set "SERVICE_DIR=%%~dpI"
)

if defined OPENCLAW_SERVICE_STARTUP_VBS (
  set "SERVICE_STARTUP_VBS=%OPENCLAW_SERVICE_STARTUP_VBS%"
) else (
  if defined SERVICE_DIR (
    set "SERVICE_STARTUP_VBS=%SERVICE_DIR%\OpenClawSilent.vbs"
  ) else (
    set "SERVICE_STARTUP_VBS="
  )
)

if defined OPENCLAW_STARTUP_DIR (
  set "STARTUP_DIR=%OPENCLAW_STARTUP_DIR%"
) else (
  set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
)

if defined OPENCLAW_STARTUP_VBS (
  set "STARTUP_VBS=%OPENCLAW_STARTUP_VBS%"
) else (
  set "STARTUP_VBS=%STARTUP_DIR%\OpenClawSilent.vbs"
)

if defined OPENCLAW_PM2_OUT_LOG (
  set "OUT_LOG=%OPENCLAW_PM2_OUT_LOG%"
) else (
  if defined SERVICE_DIR (
    set "OUT_LOG=%SERVICE_DIR%\out.log"
  ) else (
    set "OUT_LOG="
  )
)

if defined OPENCLAW_PM2_ERR_LOG (
  set "ERR_LOG=%OPENCLAW_PM2_ERR_LOG%"
) else (
  if defined SERVICE_DIR (
    set "ERR_LOG=%SERVICE_DIR%\error.log"
  ) else (
    set "ERR_LOG="
  )
)

set "WAIT_COUNT=0"
set "PM2_DISABLE_COLORS=1"
set "FORCE_COLOR=0"
set "NO_COLOR=1"

if /i "%~1"=="--start-once" goto START_ONCE
if /i "%~1"=="--stop-once" (
  call :EnsureRuntimeReady || goto EXIT_FAIL
  echo [WARN] Stopping OpenClaw PM2 tasks...
  echo [RUN] ""%NODE_EXE%"" ""%PM2_CLI%"" stop ""%APP_NAME%""
  "%NODE_EXE%" "%PM2_CLI%" stop "%APP_NAME%" >nul 2>nul
  echo [RUN] ""%NODE_EXE%"" ""%PM2_CLI%"" delete ""%APP_NAME%""
  "%NODE_EXE%" "%PM2_CLI%" delete "%APP_NAME%" >nul 2>nul
  echo [OK] Stop command finished.
  exit /b 0
)
if /i "%~1"=="--restart-once" (
  call :EnsureRuntimeReady || goto EXIT_FAIL
  echo [WARN] Restarting OpenClaw (cleaning PM2 tasks first)...
  call :RunStartFlow
  exit /b %ERRORLEVEL%
)
if /i "%~1"=="--enable-autostart-once" goto ENABLE_AUTO_ONCE
if /i "%~1"=="--disable-autostart-once" goto DISABLE_AUTO_ONCE
if /i "%~1"=="--list-once" (
  call :EnsureRuntimeReady || goto EXIT_FAIL
  echo PM2 tasks:
  echo [RUN] ""%NODE_EXE%"" ""%PM2_CLI%"" list
  "%NODE_EXE%" "%PM2_CLI%" list
  exit /b %ERRORLEVEL%
)
if /i "%~1"=="--emit-openclaw-pm2-names" goto EMIT_PM2_NAMES_ONCE

call :PrintError "[ERROR] Unsupported argument: %~1"
exit /b 1

:START_ONCE
call :EnsureRuntimeReady || goto EXIT_FAIL
call :RunStartFlow
exit /b %ERRORLEVEL%

:STOP_ONCE
call :EnsurePm2Ready || goto EXIT_FAIL
call :StopAllOpenClawPm2Apps
exit /b %ERRORLEVEL%

:ENABLE_AUTO_ONCE
call :EnsureRuntimeReady || goto EXIT_FAIL
call :PrintInfo "[INFO] Enabling startup..."
if not exist "%STARTUP_DIR%" mkdir "%STARTUP_DIR%"
call :EnsureServiceStartupVbs || goto EXIT_FAIL
call :PrintCommand "copy /y ""%SERVICE_STARTUP_VBS%"" ""%STARTUP_VBS%"""
copy /y "%SERVICE_STARTUP_VBS%" "%STARTUP_VBS%" >nul
if errorlevel 1 (
  call :PrintError "[ERROR] Failed to enable startup."
  exit /b 1
)
call :PrintSuccess "[OK] Startup enabled."
exit /b 0

:DISABLE_AUTO_ONCE
call :PrintInfo "[INFO] Disabling startup..."
call :PrintCommand "del /f /q ""%STARTUP_VBS%"""
if exist "%STARTUP_VBS%" del /f /q "%STARTUP_VBS%"
call :PrintSuccess "[OK] Startup disabled."
exit /b 0

:EMIT_PM2_NAMES_ONCE
call :EnsurePm2Ready || exit /b 1
call :GetOpenClawPm2Names
exit /b %ERRORLEVEL%

:PrintRunningTasks
call :PrintSection "PM2 tasks:"
call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" list"
"%NODE_EXE%" "%PM2_CLI%" list
exit /b %ERRORLEVEL%

:EnsureRuntimeReady
if defined NODE_EXE if defined PM2_CLI goto CHECK_INSTALLED_ARTIFACTS
call :ResolveNode || exit /b 1
call :ResolvePm2 || exit /b 1

:CHECK_INSTALLED_ARTIFACTS
call :EnsureInstalledArtifacts || exit /b 1
exit /b 0

:EnsurePm2Ready
if defined NODE_EXE if defined PM2_CLI exit /b 0
call :ResolveNode || exit /b 1
call :ResolvePm2 || exit /b 1
exit /b 0

:RunStartFlow
setlocal EnableDelayedExpansion
set "WAIT_COUNT=0"
set "FOUND_ANY="
for /f "usebackq delims=" %%I in (`call "%~f0" --emit-openclaw-pm2-names`) do (
  set "FOUND_ANY=1"
  set "APP_TO_CLEAN=%%I"
  call :PrintWarn "[WARN] Existing OpenClaw task found, cleaning: !APP_TO_CLEAN!"
  call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" stop ""!APP_TO_CLEAN!"""
  "%NODE_EXE%" "%PM2_CLI%" stop "!APP_TO_CLEAN!" >nul 2>nul
  call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" delete ""!APP_TO_CLEAN!"""
  "%NODE_EXE%" "%PM2_CLI%" delete "!APP_TO_CLEAN!" >nul 2>nul
)
if not defined FOUND_ANY (
  call :PrintInfo "[INFO] No registered OpenClaw instance found."
)
call :PrintBlank
call :PrintInfo "[INFO] Starting OpenClaw in background..."
call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" start ""%CONFIG_PATH%"" --only ""%APP_NAME%"""
"%NODE_EXE%" "%PM2_CLI%" start "%CONFIG_PATH%" --only "%APP_NAME%" >nul 2>nul

:WAIT_ONLINE
set /a WAIT_COUNT+=1
"%NODE_EXE%" "%PM2_CLI%" list | findstr /i "%APP_NAME%" | findstr /i "online" >nul 2>nul && goto REPORT_OK
if !WAIT_COUNT! GEQ 15 goto REPORT_WARN
timeout /t 1 /nobreak >nul
goto WAIT_ONLINE

:REPORT_OK
call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" save --force"
"%NODE_EXE%" "%PM2_CLI%" save --force >nul 2>nul
call :PrintBlank
call :PrintSection "PM2 status:"
call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" list"
"%NODE_EXE%" "%PM2_CLI%" list
call :PrintBlank
call :ShowRecentLogs >nul
call :PrintSection "Recent logs:"
call :ShowRecentLogs
call :PrintBlank
endlocal & exit /b 0

:REPORT_WARN
call :PrintBlank
call :PrintSection "PM2 status:"
call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" list"
"%NODE_EXE%" "%PM2_CLI%" list
call :PrintBlank
call :ShowRecentLogs >nul
call :PrintSection "Recent logs:"
call :ShowRecentLogs
call :PrintBlank
call :PrintError "[ERROR] OpenClaw startup check timed out."
endlocal & exit /b 1

:ShowRecentLogs
if exist "%OUT_LOG%" powershell -NoProfile -Command "Get-Content -Encoding UTF8 -Path '%OUT_LOG%' -Tail 10"
if exist "%ERR_LOG%" powershell -NoProfile -Command "Get-Content -Encoding UTF8 -Path '%ERR_LOG%' -Tail 10"
exit /b 0

:StopAllOpenClawPm2Apps
setlocal EnableDelayedExpansion
set "STOPPED_COUNT=0"
for /f "usebackq delims=" %%I in (`call "%~f0" --emit-openclaw-pm2-names`) do (
  set /a STOPPED_COUNT+=1
  set "APP_TO_STOP=%%I"
  call :PrintWarn "[WARN] Stopping OpenClaw task: !APP_TO_STOP!"
  call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" stop ""!APP_TO_STOP!"""
  "%NODE_EXE%" "%PM2_CLI%" stop "!APP_TO_STOP!" >nul 2>nul
  call :PrintCommand """%NODE_EXE%"" ""%PM2_CLI%"" delete ""!APP_TO_STOP!"""
  "%NODE_EXE%" "%PM2_CLI%" delete "!APP_TO_STOP!" >nul 2>nul
)
if !STOPPED_COUNT! EQU 0 (
  call :PrintWarn "[WARN] No running OpenClaw PM2 task found."
  endlocal & exit /b 0
)
call :PrintSuccess "[OK] Stopped !STOPPED_COUNT! OpenClaw PM2 task(s)."
endlocal & exit /b 0

:GetOpenClawPm2Names
"%NODE_EXE%" -e "const cp=require('child_process');const result=cp.spawnSync(process.execPath,[process.env.PM2_CLI,'jlist'],{encoding:'utf8',windowsHide:true});if(result.error||result.status!==0){process.exit(0)};const json=(result.stdout||'').trim();if(!json){process.exit(0)};let apps;try{apps=JSON.parse(json)}catch{process.exit(0)};const names=[...new Set((Array.isArray(apps)?apps:[]).filter((app)=>{const name=String((app&&app.name)||'');const execPath=String((app&&app.pm2_env&&app.pm2_env.pm_exec_path)||'');const rawArgs=app&&app.pm2_env&&app.pm2_env.args;const args=Array.isArray(rawArgs)?rawArgs.join(' '):String(rawArgs||'');return (name+' '+execPath+' '+args).toLowerCase().includes('openclaw')}).map((app)=>String(app&&app.name||'')).filter(Boolean))];if(names.length){process.stdout.write(names.join(require('os').EOL))}"
exit /b 0

:ResolveNode
if defined OPENCLAW_NODE_EXE if exist "%OPENCLAW_NODE_EXE%" (
  set "NODE_EXE=%OPENCLAW_NODE_EXE%"
  exit /b 0
)
set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%~fI"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE (
  call :PrintError "[ERROR] Unable to find node.exe."
  exit /b 1
)
exit /b 0

:ResolvePm2
if defined OPENCLAW_PM2_CLI if exist "%OPENCLAW_PM2_CLI%" (
  set "PM2_CLI=%OPENCLAW_PM2_CLI%"
  exit /b 0
)
set "PM2_CLI="
if defined APPDATA if exist "%APPDATA%\npm\node_modules\pm2\bin\pm2" set "PM2_CLI=%APPDATA%\npm\node_modules\pm2\bin\pm2"
if not defined PM2_CLI if exist "%ProgramFiles%\nodejs\node_modules\pm2\bin\pm2" set "PM2_CLI=%ProgramFiles%\nodejs\node_modules\pm2\bin\pm2"
if not defined PM2_CLI if exist "%ProgramFiles(x86)%\nodejs\node_modules\pm2\bin\pm2" set "PM2_CLI=%ProgramFiles(x86)%\nodejs\node_modules\pm2\bin\pm2"
if not defined PM2_CLI for /f "delims=" %%I in ('where pm2 2^>nul') do if not defined PM2_CLI if exist "%%~dpI\node_modules\pm2\bin\pm2" set "PM2_CLI=%%~dpI\node_modules\pm2\bin\pm2"
if not defined PM2_CLI for /f "usebackq delims=" %%I in (`npm root -g 2^>nul`) do if not defined PM2_CLI if exist "%%~I\pm2\bin\pm2" set "PM2_CLI=%%~I\pm2\bin\pm2"
if not defined PM2_CLI for /f "usebackq delims=" %%I in (`npm config get prefix 2^>nul`) do if not defined PM2_CLI if exist "%%~I\node_modules\pm2\bin\pm2" set "PM2_CLI=%%~I\node_modules\pm2\bin\pm2"
if not defined PM2_CLI (
  call :PrintError "[ERROR] Unable to find PM2 CLI entry. Please rerun the installer."
  exit /b 1
)
exit /b 0

:ResolveConfigPath
if defined OPENCLAW_SERVICE_DIR if exist "%OPENCLAW_SERVICE_DIR%\ecosystem.config.js" (
  set "CONFIG_PATH=%OPENCLAW_SERVICE_DIR%\ecosystem.config.js"
  exit /b 0
)
if exist "%USERPROFILE%\.openclaw\pm2-service\ecosystem.config.js" (
  set "CONFIG_PATH=%USERPROFILE%\.openclaw\pm2-service\ecosystem.config.js"
  exit /b 0
)
for %%R in ("%SystemDrive%\\" "C:\\" "D:\\" "E:\\" "F:\\" "G:\\" "Z:\\") do (
  call :TryResolveConfigInRoot "%%~R"
  if defined CONFIG_PATH exit /b 0
)
if defined CONFIG_PATH exit /b 0
call :PrintError "[ERROR] Unable to resolve ecosystem.config.js dynamically."
  exit /b 1

:TryResolveConfigInRoot
set "SCAN_ROOT=%~1"
if not exist "%SCAN_ROOT%" exit /b 0
for /d %%D in ("%SCAN_ROOT%openclaw*") do (
  if exist "%%~fD\ecosystem.config.js" (
    set "CONFIG_PATH=%%~fD\ecosystem.config.js"
    exit /b 0
  )
)
exit /b 0

:EnsureInstalledArtifacts
if not exist "%CONFIG_PATH%" (
  call :PrintError "[ERROR] Missing OpenClaw service config: %CONFIG_PATH%"
  call :PrintError "[ERROR] Please rerun the installer first."
  exit /b 1
)
exit /b 0

:EnsureServiceStartupVbs
if exist "%SERVICE_STARTUP_VBS%" exit /b 0
> "%SERVICE_STARTUP_VBS%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%SERVICE_STARTUP_VBS%" echo WshShell.Run """%NODE_EXE%"" ""%PM2_CLI%"" resurrect", 0, False
if exist "%SERVICE_STARTUP_VBS%" exit /b 0
call :PrintError "[ERROR] Unable to create startup VBS: %SERVICE_STARTUP_VBS%"
exit /b 1

:EXIT_FAIL
exit /b 1

:PrintBlank
echo.
exit /b 0

:PrintSection
echo %~1
exit /b 0

:PrintInfo
echo %~1
exit /b 0

:PrintSuccess
echo %~1
exit /b 0

:PrintWarn
echo %~1
exit /b 0

:PrintError
>&2 echo %~1
exit /b 0

:PrintCommand
echo [RUN] %~1
exit /b 0
