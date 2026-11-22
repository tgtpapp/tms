@echo off
chcp 65001 > nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Read-Host 'Dan ma duong ham Cloudflare (Tunnel token)' -AsSecureString; $s | ConvertFrom-SecureString | Set-Content '%~dp0duong-ham.dat'; Write-Host 'Da luu.'"
pause
