@echo off
rem Sanguosha OL resource WebUI launcher (downloader + skin player)
rem The server runs in THIS terminal window. Close the window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  set PY=python
) else (
  where py >nul 2>nul
  if %errorlevel%==0 (
    set PY=py -3
  ) else (
    echo [ERROR] Python not found. Please install Python 3 first.
    pause
    exit /b 1
  )
)
title Sanguosha OL Resource WebUI
"%PY%" server.py
pause