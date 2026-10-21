@echo off
cd /d %~dp0
py -3 -m venv venv
call venv\Scripts\activate
pip install -r requirements.txt
echo.
echo Aapki FERNET_KEY (run.bat me paste karein, surakshit rakhein):
python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"
pause
