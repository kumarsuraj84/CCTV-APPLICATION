# CCTV Hub (Windows + SQL Server)

## Pehli baar setup
1. Install: Python 3.11+ (Add to PATH tick karein), "ODBC Driver 18 for SQL Server", aur SQL Server (Express free hai).
2. SQL Server me ek khaali database banayein: `CREATE DATABASE cctv;` (tables app khud bana legi).
3. go2rtc: https://github.com/AlexxIT/go2rtc/releases se `go2rtc_win64.zip` download karke `go2rtc.exe` isi folder me rakhein.
4. `setup.bat` double-click karein. Ant me jo FERNET_KEY dikhe use copy karein.
5. `run.bat` kholkar FERNET_KEY, APP_PASS aur SQL_CONN (server ka naam / login) badlein.

## Roz chalane ke liye
`run.bat` chalayein, phir browser me `http://SERVER-IP:8000` kholein, login karein,
**CSV import** se stores daalein (`stores_sample.csv` jaisa), phir **कैमरा खोजें** dabayein.

## Windows Firewall
Port 8000 (TCP), 1984 (TCP), 8555 (TCP + UDP) sirf office/VPN network ke liye allow karein.

## Server band hone par bhi apne aap chalu ho
NSSM (free) se `run.bat` ko Windows Service bana sakte hain, ya Task Scheduler me "At startup" lagayein.

## Dhyan rahe
- Camera sub-stream H.264 rakhein, NVR par read-only user banayein.
- FERNET_KEY kho gayi to saved NVR passwords wapas nahi khulenge.
- SQL Server me Windows login chahiye to `Trusted_Connection=yes`, warna `UID=user;PWD=pass` use karein.
