@echo off
start "" /D "%~dp0" "%~dp0..\..\node_modules\electron\dist\electron.exe" "%~dp0main.cjs"
