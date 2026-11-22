@echo off
chcp 65001 > nul
docker rm -f tms-tren-may tms-may-chu tms-duong-ham > nul 2> nul
"%~dp0supabase.exe" stop --workdir "%~dp0he-thong"
echo Da tat TMS tren may.
pause
