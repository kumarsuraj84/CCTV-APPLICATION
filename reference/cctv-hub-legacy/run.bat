@echo off
cd /d %~dp0
set "FERNET_KEY=PASTE_KEY_HERE"
set "APP_USER=admin"
set "APP_PASS=change-me"
set "SQL_CONN=DRIVER={ODBC Driver 18 for SQL Server};SERVER=localhost;DATABASE=cctv;Trusted_Connection=yes;TrustServerCertificate=yes"
start "go2rtc" go2rtc.exe
call venv\Scripts\activate
uvicorn app:app --host 0.0.0.0 --port 8000
