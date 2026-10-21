import os, csv, io, re, json, asyncio, secrets, hashlib, hmac, time, base64
from urllib.parse import quote
import httpx, pyodbc
from cryptography.fernet import Fernet
from fastapi import FastAPI, Depends, HTTPException, UploadFile, Request, WebSocket
from fastapi.responses import FileResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials

GO2RTC = os.getenv("GO2RTC_URL", "http://127.0.0.1:1984")
APP_USER, APP_PASS = os.getenv("APP_USER", "admin"), os.getenv("APP_PASS", "change-me")
fernet = Fernet(os.environ["FERNET_KEY"].encode())
CONN = os.environ["SQL_CONN"]

def q(sql, p=()):
    """SQL Server query helper: returns list of dicts for SELECT, rowcount otherwise."""
    with pyodbc.connect(CONN, autocommit=True) as c:
        cur = c.cursor(); cur.execute(sql, p)
        if cur.description is None: return cur.rowcount
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

q("""IF OBJECT_ID('stores','U') IS NULL CREATE TABLE stores(
  id INT IDENTITY PRIMARY KEY, name NVARCHAR(200) UNIQUE, city NVARCHAR(100), zone NVARCHAR(100),
  ip VARCHAR(100), port INT, http_port INT, username NVARCHAR(100), pw NVARCHAR(500), channels INT)""")
q("""IF OBJECT_ID('cameras','U') IS NULL CREATE TABLE cameras(
  store_id INT, ch INT, name NVARCHAR(200), PRIMARY KEY(store_id, ch))""")

q("""IF OBJECT_ID('cam_groups','U') IS NULL CREATE TABLE cam_groups(id INT IDENTITY PRIMARY KEY, name NVARCHAR(200) UNIQUE)""")
q("""IF OBJECT_ID('cam_group_items','U') IS NULL CREATE TABLE cam_group_items(
  group_id INT, store_id INT, ch INT, PRIMARY KEY(group_id, store_id, ch))""")

q("""IF OBJECT_ID('app_users','U') IS NULL CREATE TABLE app_users(
  username NVARCHAR(100) PRIMARY KEY, pw_hash NVARCHAR(300), role NVARCHAR(20), created DATETIME2)""")

q("IF COL_LENGTH('app_users','can_groups') IS NULL ALTER TABLE app_users ADD can_groups BIT NOT NULL DEFAULT 0")

def _hash(pw):
    salt = secrets.token_bytes(16)
    return salt.hex() + "$" + hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 120_000).hex()

def _verify(pw, stored):
    try:
        s, h = stored.split("$")
        return secrets.compare_digest(hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(s), 120_000).hex(), h)
    except Exception:
        return False

_AUTHC = {}
def _login(u, p):
    """Main admin (run.bat wala) ya app_users table ka user. Nateeja: {"name","role"} ya None."""
    if secrets.compare_digest(u.encode(), APP_USER.encode()) and secrets.compare_digest(p.encode(), APP_PASS.encode()):
        return {"name": u, "role": "admin", "can_groups": True}
    key = hashlib.sha256(f"{u}\0{p}".encode()).hexdigest(); hit = _AUTHC.get(key)
    if hit and hit[1] > time.time(): return hit[0]
    rows = q("select pw_hash, role, can_groups from app_users where username=?", (u,))
    if rows and _verify(p, rows[0]["pw_hash"]):
        user = {"name": u, "role": rows[0]["role"], "can_groups": bool(rows[0]["can_groups"]) or rows[0]["role"] == "admin"}; _AUTHC[key] = (user, time.time() + 600); return user
    return None

class AuthMW:
    """Har HTTP request par login jaanchta hai (streaming responses ko bina chhede)."""
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http": return await self.app(scope, receive, send)
        hdr = dict(scope["headers"]).get(b"authorization", b"").decode(); user = None
        if hdr.lower().startswith("basic "):
            try:
                u, p = base64.b64decode(hdr[6:]).decode().split(":", 1); user = await asyncio.to_thread(_login, u, p)
            except Exception:
                user = None
        if not user:
            await send({"type": "http.response.start", "status": 401, "headers": [(b"www-authenticate", b'Basic realm="CCTV Hub"'), (b"content-type", b"text/plain; charset=utf-8")]})
            await send({"type": "http.response.body", "body": b"Login required"}); return
        scope["state"] = {**scope.get("state", {}), "user": user}
        await self.app(scope, receive, send)

def auth(request: Request): return request.state.user

def admin(user: dict = Depends(auth)):
    if user["role"] != "admin": raise HTTPException(403, "Yeh kaam sirf admin kar sakta hai")
    return user

def groups_ok(user: dict = Depends(auth)):
    if user["role"] != "admin" and not user.get("can_groups"): raise HTTPException(403, "Aapko group badalne ki anumati nahi hai")
    return user

app = FastAPI()
app.add_middleware(AuthMW)

@app.get("/api/me")
def me(user: dict = Depends(auth)): return user

@app.get("/")
def index(): return FileResponse("index.html")

LOGO_EXT = ("png", "jpg", "jpeg", "svg", "webp")

@app.get("/api/brand")
def brand():
    d = {"name": "My Stores", "subtitle": "Live store monitoring", "color": "#1d4ed8"}
    try: d.update(json.load(open("brand.json", encoding="utf-8")))
    except Exception: pass
    d["logo"] = any(os.path.exists(f"logo.{e}") for e in LOGO_EXT)
    return d

@app.get("/logo")
def logo():
    for e in LOGO_EXT:
        if os.path.exists(f"logo.{e}"): return FileResponse(f"logo.{e}")
    raise HTTPException(404)

@app.get("/api/stores")
def stores():
    return q("""select s.id,s.name,s.city,s.zone,s.ip,
      (select count(*) from cameras where store_id=s.id) as cams from stores s order by s.name""")

@app.post("/api/import", dependencies=[Depends(admin)])
async def import_csv(file: UploadFile):
    text = (await file.read()).decode("utf-8-sig")
    n = 0
    for r in csv.DictReader(io.StringIO(text)):
        v = (r.get("city"), r.get("zone"), r["ip"], int(r.get("port") or 554), int(r.get("http_port") or 80),
             r["user"], fernet.encrypt(r["password"].encode()).decode(), int(r.get("channels") or 0))
        if q("update stores set city=?,zone=?,ip=?,port=?,http_port=?,username=?,pw=?,channels=? where name=?", v + (r["name"],)) == 0:
            q("insert into stores(city,zone,ip,port,http_port,username,pw,channels,name) values(?,?,?,?,?,?,?,?,?)", v + (r["name"],))
        n += 1
    return {"imported": n}

def get_store(sid):
    rows = q("select * from stores where id=?", (sid,))
    if not rows: raise HTTPException(404)
    return rows[0]

async def discover(s):
    pw = fernet.decrypt(s["pw"].encode()).decode()
    base = f"http://{s['ip']}:{s['http_port']}"
    found = []
    try:
        async with httpx.AsyncClient(auth=httpx.DigestAuth(s["username"], pw), timeout=8) as h:
            for path, tag in (("/ISAPI/ContentMgmt/InputProxy/channels", "InputProxyChannel"),
                              ("/ISAPI/System/Video/inputs/channels", "VideoInputChannel")):
                r = await h.get(base + path)
                if r.status_code == 200:
                    found = re.findall(rf"<{tag}\b.*?<id>(\d+)</id>.*?<name>(.*?)</name>", r.text, re.S)
                    if found: break
    except Exception:
        pass
    if not found and s["channels"]:
        found = [(str(i), f"Camera {i}") for i in range(1, s["channels"] + 1)]
    cams = {int(i): n for i, n in found}
    q("delete from cameras where store_id=?", (s["id"],))
    for ch, n in cams.items():
        q("insert into cameras(store_id,ch,name) values(?,?,?)", (s["id"], ch, n))
    return len(cams)

@app.post("/api/stores/{sid}/discover", dependencies=[Depends(admin)])
async def discover_one(sid: int): return {"cameras": await discover(get_store(sid))}

@app.post("/api/discover-all", dependencies=[Depends(admin)])
async def discover_all():
    rows = q("select * from stores")
    sem = asyncio.Semaphore(10)
    async def run(s):
        async with sem: return await discover(s)
    res = await asyncio.gather(*(run(s) for s in rows))
    return {"stores": len(rows), "cameras": sum(res)}

CAM_SQL = """select c.store_id,c.ch,c.name,s.name as store_name,s.ip,s.port,s.http_port,s.username,s.pw
  from cameras c join stores s on s.id=c.store_id """

async def register(rows):
    """Register main+sub streams of the given cameras in go2rtc (Hikvision: ch*100+stream, 101=main, 102=sub)."""
    out, jobs = [], []
    async with httpx.AsyncClient(timeout=10, limits=httpx.Limits(max_connections=20)) as h:
        async def reg(name, r, pw, stream):
            src = f"rtsp://{quote(r['username'])}:{quote(pw)}@{r['ip']}:{r['port']}/Streaming/Channels/{r['ch']}0{stream}"
            await h.put(f"{GO2RTC}/api/streams", params={"name": name, "src": src})
        for r in rows:
            pw = fernet.decrypt(r["pw"].encode()).decode()
            sub, main = f"s{r['store_id']}c{r['ch']}_sub", f"s{r['store_id']}c{r['ch']}_main"
            jobs += [reg(sub, r, pw, 2), reg(main, r, pw, 1)]
            out.append({"store_id": r["store_id"], "ch": r["ch"], "name": r["name"], "store": r["store_name"], "sub": sub, "main": main})
        await asyncio.gather(*jobs)
    return out

@app.post("/api/stores/{sid}/open")
async def open_store(sid: int):
    get_store(sid)
    return await register(q(CAM_SQL + "where c.store_id=? order by c.ch", (sid,)))

@app.get("/api/groups")
def groups():
    return q("""select g.id,g.name,(select count(*) from cam_group_items where group_id=g.id) as cams
      from cam_groups g order by g.name""")

@app.post("/api/groups", dependencies=[Depends(groups_ok)])
def new_group(name: str):
    try: q("insert into cam_groups(name) values(?)", (name.strip(),))
    except pyodbc.IntegrityError: raise HTTPException(409, "इस नाम का ग्रुप पहले से है")
    return {"ok": True}

@app.delete("/api/groups/{gid}", dependencies=[Depends(groups_ok)])
def del_group(gid: int):
    q("delete from cam_group_items where group_id=?", (gid,)); q("delete from cam_groups where id=?", (gid,))
    return {"ok": True}

@app.post("/api/groups/{gid}/add", dependencies=[Depends(groups_ok)])
def add_cam(gid: int, store_id: int, ch: int):
    q("""if not exists(select 1 from cam_group_items where group_id=? and store_id=? and ch=?)
         insert into cam_group_items values(?,?,?)""", (gid, store_id, ch, gid, store_id, ch))
    return {"ok": True}

@app.post("/api/groups/{gid}/add-by-name", dependencies=[Depends(groups_ok)])
def add_by_name(gid: int, keyword: str):
    n = q("""insert into cam_group_items(group_id,store_id,ch)
      select ?,c.store_id,c.ch from cameras c where c.name like ? and not exists(
        select 1 from cam_group_items i where i.group_id=? and i.store_id=c.store_id and i.ch=c.ch)""",
      (gid, f"%{keyword}%", gid))
    return {"added": n}

@app.delete("/api/groups/{gid}/cam", dependencies=[Depends(groups_ok)])
def rm_cam(gid: int, store_id: int, ch: int):
    q("delete from cam_group_items where group_id=? and store_id=? and ch=?", (gid, store_id, ch))
    return {"ok": True}

@app.post("/api/groups/{gid}/open")
async def open_group(gid: int):
    return await register(q(CAM_SQL + """join cam_group_items i on i.store_id=c.store_id and i.ch=c.ch
      where i.group_id=? order by s.name, c.ch""", (gid,)))

async def ping(s):
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(s["ip"], s["port"]), 2)
        w.close(); return True
    except Exception:
        return False

@app.get("/api/status")
async def status():
    rows = q("select id,ip,port from stores")
    res = await asyncio.gather(*(ping(r) for r in rows))
    return {r["id"]: ok for r, ok in zip(rows, res)}


# ---------------- Playback (Hikvision RTSP: /Streaming/tracks/<ch>01?starttime=..&endtime=..) ----------------
from datetime import datetime, timedelta
from pydantic import BaseModel

PB_OFFSET = int(os.getenv("PLAYBACK_OFFSET_MIN", "0"))  # e.g. 330 if NVR expects true UTC and you are in India

class PbItem(BaseModel):
    store_id: int
    ch: int

class PbReq(BaseModel):
    items: list[PbItem]
    start: str          # local time "YYYY-MM-DDTHH:MM"
    minutes: int = 10
    off: int | None = None   # NVR ka time offset (minute): 0 = Local, 330 = UTC

@app.post("/api/playback")
async def playback(req: PbReq):
    t0 = datetime.strptime(req.start, "%Y-%m-%dT%H:%M:%S" if req.start.count(":") == 2 else "%Y-%m-%dT%H:%M") - timedelta(minutes=PB_OFFSET if req.off is None else req.off)
    t1 = t0 + timedelta(minutes=max(1, min(req.minutes, 1440)))
    f = lambda t: t.strftime("%Y%m%dT%H%M%SZ")
    rows = []
    for it in req.items:
        rows += q(CAM_SQL + "where c.store_id=? and c.ch=?", (it.store_id, it.ch))
    out = []
    async with httpx.AsyncClient(timeout=10, limits=httpx.Limits(max_connections=20)) as h:
        async def reg(r):
            pw = fernet.decrypt(r["pw"].encode()).decode()
            name = f"pb{r['store_id']}c{r['ch']}_{f(t0)}"
            src = (f"rtsp://{quote(r['username'])}:{quote(pw)}@{r['ip']}:{r['port']}"
                   f"/Streaming/tracks/{r['ch']}01?starttime={f(t0)}&endtime={f(t1)}")
            await h.put(f"{GO2RTC}/api/streams", params={"name": name, "src": src})
            out.append({"store_id": r["store_id"], "ch": r["ch"], "stream": name})
        await asyncio.gather(*(reg(r) for r in rows))
    return out


# ---------------- Backup: NVR HDD se recordings download karke is PC ki disk par save karna ----------------
import uuid, shutil, pathlib

BACKUP_DIR = pathlib.Path(os.getenv("BACKUP_DIR", "backups"))
JOBS, TASKS = {}, set()

class BkReq(BaseModel):
    items: list[PbItem]
    start: str = ""     # "YYYY-MM-DDTHH:MM", khaali = NVR me jo sabse purani recording hai wahin se
    end: str

_z = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
_safe = lambda s: re.sub(r"[^\w\- ]+", "_", str(s)).strip() or "x"

async def isapi_search(h, base, ch, t0, t1, pos=0, limit=200, raw=False):
    body = ("<?xml version='1.0' encoding='utf-8'?><CMSearchDescription><searchID>%s</searchID>"
            "<trackIDList><trackID>%d01</trackID></trackIDList><timeSpanList><timeSpan><startTime>%s</startTime>"
            "<endTime>%s</endTime></timeSpan></timeSpanList><maxResults>%d</maxResults>"
            "<searchResultPostion>%d</searchResultPostion><metadataList><metadataDescriptor>"
            "//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>"
            % (uuid.uuid4(), ch, _z(t0), _z(t1), limit, pos))
    r = await h.post(base + "/ISAPI/ContentMgmt/search", content=body, headers={"Content-Type": "application/xml"})
    r.raise_for_status()
    more = "<responseStatusStrg>MORE</responseStatusStrg>" in r.text
    if raw: return re.findall(r"<searchMatchItem>.*?</searchMatchItem>", r.text, re.S), more
    out = []
    for it in re.findall(r"<searchMatchItem>.*?</searchMatchItem>", r.text, re.S):
        st = re.search(r"<startTime>(.*?)</startTime>", it); uri = re.search(r"<playbackURI>(.*?)</playbackURI>", it)
        if st and uri: out.append((st.group(1), uri.group(1)))
    return out, "<responseStatusStrg>MORE</responseStatusStrg>" in r.text

async def isapi_download(h, base, uri, path, job):
    body = ("<?xml version='1.0' encoding='utf-8'?><downloadRequest version='1.0' "
            "xmlns='http://www.isapi.org/ver20/XMLSchema'><playbackURI>%s</playbackURI></downloadRequest>" % uri)
    tmp = path.with_suffix(".part")
    async with h.stream("POST", base + "/ISAPI/ContentMgmt/download", content=body, headers={"Content-Type": "application/xml"}) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            async for chunk in r.aiter_bytes(1 << 20):
                f.write(chunk); job["bytes"] += len(chunk)
    tmp.replace(path)

async def run_backup(job, rows, t0, t1):
    locks, gsem = {}, asyncio.Semaphore(4)       # ek NVR par ek baar me ek hi download, kul 4 NVR ek saath
    async def one(r):
        async with gsem, locks.setdefault(r["store_id"], asyncio.Lock()):
            try:
                pw = fernet.decrypt(r["pw"].encode()).decode()
                base = f"http://{r['ip']}:{r['http_port']}"
                async with httpx.AsyncClient(auth=httpx.DigestAuth(r["username"], pw), timeout=httpx.Timeout(30, read=900)) as h:
                    a = t0
                    if a is None:
                        first, _ = await isapi_search(h, base, r["ch"], t1 - timedelta(days=400), t1, 0, 1)
                        if not first: raise RuntimeError("koi recording nahi mili")
                        a = datetime.strptime(first[0][0][:19], "%Y-%m-%dT%H:%M:%S")
                    pos = 0
                    while True:
                        items, more = await isapi_search(h, base, r["ch"], a, t1, pos)
                        for st, uri in items:
                            d = BACKUP_DIR / _safe(r["store_name"]) / _safe("%02d_%s" % (r["ch"], r["name"]))
                            d.mkdir(parents=True, exist_ok=True)
                            f = d / (re.sub(r"\D", "", st)[:14] + ".mp4")
                            if not f.exists(): await isapi_download(h, base, uri, f, job)
                            job["files"] += 1
                        if not more or not items: break
                        pos += len(items)
            except Exception as e:
                job["errors"].append(f"{r['store_name']} cam{r['ch']}: {type(e).__name__} {str(e)[:60]}")
            job["done"] += 1
    await asyncio.gather(*(one(r) for r in rows))
    job["status"] = "done"

@app.post("/api/backup", dependencies=[Depends(admin)])
async def backup_start(req: BkReq):
    t1 = datetime.strptime(req.end, "%Y-%m-%dT%H:%M") - timedelta(minutes=PB_OFFSET)
    t0 = datetime.strptime(req.start, "%Y-%m-%dT%H:%M") - timedelta(minutes=PB_OFFSET) if req.start else None
    rows = []
    for it in req.items:
        rows += q(CAM_SQL + "where c.store_id=? and c.ch=?", (it.store_id, it.ch))
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    job = {"id": uuid.uuid4().hex[:8], "total": len(rows), "done": 0, "files": 0, "bytes": 0, "errors": [],
           "status": "running", "dir": str(BACKUP_DIR.resolve())}
    JOBS[job["id"]] = job
    t = asyncio.create_task(run_backup(job, rows, t0, t1)); TASKS.add(t); t.add_done_callback(TASKS.discard)
    return job

@app.get("/api/backup/{jid}", dependencies=[Depends(admin)])
def backup_status(jid: str):
    if jid not in JOBS: raise HTTPException(404)
    return {**JOBS[jid], "free": shutil.disk_usage(BACKUP_DIR).free}


# ---------------- Hikvision jaisa playback timeline: NVR me kab-kab recording hai ----------------
def _base(r): return f"http://{r['ip']}:{r['http_port']}"

def _nvr(r):
    pw = fernet.decrypt(r["pw"].encode()).decode()
    return httpx.AsyncClient(auth=httpx.DigestAuth(r["username"], pw), timeout=httpx.Timeout(30, read=60))

def _local(s, off=None): return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S") + timedelta(minutes=PB_OFFSET if off is None else off)

def _cam(store_id, ch):
    rows = q(CAM_SQL + "where c.store_id=? and c.ch=?", (store_id, ch))
    if not rows: raise HTTPException(404)
    return rows[0]

async def _timeline(store_id: int, ch: int, date: str, off=None):
    r = _cam(store_id, ch)
    day0 = datetime.strptime(date, "%Y-%m-%d")
    off = PB_OFFSET if off is None else off
    t0 = day0 - timedelta(minutes=off); t1 = t0 + timedelta(days=1)
    segs, pos = [], 0
    async with _nvr(r) as h:
        while True:
            items, more = await isapi_search(h, _base(r), ch, t0, t1, pos, 200, raw=True)
            for it in items:
                s_ = re.search(r"<startTime>(.*?)</startTime>", it); e_ = re.search(r"<endTime>(.*?)</endTime>", it)
                if s_ and e_:
                    s = max(0, int((_local(s_.group(1), off) - day0).total_seconds())); e = min(86400, int((_local(e_.group(1), off) - day0).total_seconds()))
                    if e > s: segs.append([s, e])
            if not more or not items: break
            pos += len(items)
    return {"segments": sorted(segs)}

@app.get("/api/oldest")
async def oldest(store_id: int, ch: int, off: int = None):
    r = _cam(store_id, ch)
    off = PB_OFFSET if off is None else off
    now = datetime.now() - timedelta(minutes=off)
    async with _nvr(r) as h:
        items, _ = await isapi_search(h, _base(r), ch, now - timedelta(days=400), now + timedelta(days=1), 0, 1, raw=True)
    s_ = re.search(r"<startTime>(.*?)</startTime>", items[0]) if items else None
    return {"oldest": _local(s_.group(1), off).strftime("%Y-%m-%d") if s_ else None}


@app.get("/api/timeline")
async def timeline(store_id: int, ch: int, date: str, off: int = None):
    try:
        return await _timeline(store_id, ch, date, off)
    except HTTPException:
        raise
    except Exception as e:      # NVR ne mana kiya (401/403 = user ko playback ki permission nahi) ya connect nahi hua
        body = getattr(getattr(e, "response", None), "text", "") or ""
        m = re.search(r"<statusString>(.*?)</statusString>", body)
        return {"segments": [], "error": f"{type(e).__name__}: {str(e)[:110]} {m.group(1) if m else ''}".strip()}


import calendar

@app.get("/api/days")
async def days(store_id: int, ch: int, year: int, month: int, off: int = None):
    """Is mahine ke kin dino ki recording NVR me hai (Hikvision calendar jaisa)."""
    try:
        r = _cam(store_id, ch); off = PB_OFFSET if off is None else off
        async with _nvr(r) as h:
            try:   # sahi tarika: NVR ka dailyDistribution
                body = "<?xml version='1.0' encoding='utf-8'?><trackDailyParam><year>%d</year><monthOfYear>%d</monthOfYear></trackDailyParam>" % (year, month)
                resp = await h.post(_base(r) + f"/ISAPI/ContentMgmt/record/tracks/{ch}01/dailyDistribution", content=body, headers={"Content-Type": "application/xml"})
                resp.raise_for_status()
                blocks = re.findall(r"<day>(.*?)</day>", resp.text, re.S)
                if blocks:
                    out = []
                    for b in blocks:
                        rec = re.search(r"<record>(.*?)</record>", b)
                        d = re.search(r"<dayOfMonth>(\d+)</dayOfMonth>", b) or re.search(r"<id>(\d+)</id>", b)
                        if d and rec and rec.group(1).strip().lower() == "true": out.append(int(d.group(1)))
                    return {"days": sorted(out)}
            except Exception:
                pass
            sem = asyncio.Semaphore(6)    # dusra tarika: har din ke liye 1 search
            async def chk(d):
                async with sem:
                    t0 = datetime(year, month, d) - timedelta(minutes=off)
                    items, _ = await isapi_search(h, _base(r), ch, t0, t0 + timedelta(days=1), 0, 1, raw=True)
                    return d if items else None
            res = await asyncio.gather(*(chk(d) for d in range(1, calendar.monthrange(year, month)[1] + 1)), return_exceptions=True)
            errs = [x for x in res if isinstance(x, Exception)]
            if errs and len(errs) == len(res): raise errs[0]
            return {"days": [d for d in res if isinstance(d, int)]}
    except HTTPException:
        raise
    except Exception as e:
        return {"days": [], "error": f"{type(e).__name__}: {str(e)[:110]}"}


# ---------------- Tez playback (2x/4x/8x): NVR se bulk download (network speed) -> ffmpeg se fMP4 -> browser <video> ----------------
from fastapi.responses import StreamingResponse

FFMPEG = os.getenv("FFMPEG", "ffmpeg.exe" if os.name == "nt" else "ffmpeg")

async def _vod_body(r, ch, t0, t1):
    zf = lambda t: t.strftime("%Y%m%dT%H%M%SZ")
    try:
        async with _nvr(r) as h:
            items, _ = await isapi_search(h, _base(r), ch, t0, t1, 0, 1, raw=True)
    except Exception as e:
        raise HTTPException(502, f"NVR se recording list nahi mili: {type(e).__name__} {str(e)[:80]}")
    if not items: raise HTTPException(404, "is samay ki recording nahi mili")
    it = items[0]
    uri = re.search(r"<playbackURI>(.*?)</playbackURI>", it).group(1)
    s_ = re.search(r"<startTime>(.*?)</startTime>", it); e_ = re.search(r"<endTime>(.*?)</endTime>", it)
    a0 = max(t0, datetime.strptime(s_.group(1)[:19], "%Y-%m-%dT%H:%M:%S")) if s_ else t0
    a1 = min(t1, datetime.strptime(e_.group(1)[:19], "%Y-%m-%dT%H:%M:%S")) if e_ else t1
    uri = re.sub(r"starttime=[^&]*", "starttime=" + zf(a0), uri, count=1)
    uri = re.sub(r"endtime=[^&]*", "endtime=" + zf(a1), uri, count=1)
    body = ("<?xml version='1.0' encoding='utf-8'?><downloadRequest version='1.0' "
            "xmlns='http://www.isapi.org/ver20/XMLSchema'><playbackURI>%s</playbackURI></downloadRequest>" % uri)
    return body

@app.get("/api/vod")
async def vod(store_id: int, ch: int, start: str, minutes: int = 10, off: int = None):
    r = _cam(store_id, ch); off = PB_OFFSET if off is None else off
    t0 = datetime.strptime(start, "%Y-%m-%dT%H:%M:%S") - timedelta(minutes=off)
    t1 = t0 + timedelta(minutes=max(1, min(minutes, 30)))
    body = await _vod_body(r, ch, t0, t1)
    try:
        ff = await asyncio.create_subprocess_exec(
            FFMPEG, "-loglevel", "error", "-i", "pipe:0", "-an", "-c:v", "copy",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-flush_packets", "1", "-f", "mp4", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    except FileNotFoundError:
        raise HTTPException(500, "ffmpeg.exe nahi mila - use C:\\cctv-hub folder me rakhein")

    async def feeder():
        try:
            async with _nvr(r) as h:
                async with h.stream("POST", _base(r) + "/ISAPI/ContentMgmt/download", content=body,
                                    headers={"Content-Type": "application/xml"}) as resp:
                    resp.raise_for_status()
                    async for chunk in resp.aiter_bytes(1 << 18):
                        ff.stdin.write(chunk); await ff.stdin.drain()
        except Exception:
            pass
        finally:
            try: ff.stdin.close()
            except Exception: pass

    task = asyncio.create_task(feeder())

    async def gen():
        try:
            while True:
                data = await ff.stdout.read(1 << 16)
                if not data: break
                yield data
        finally:
            task.cancel()
            if ff.returncode is None:
                try: ff.kill()
                except Exception: pass
    return StreamingResponse(gen(), media_type="video/mp4")


# ---------------- Camera report: kitne camera live hain (store-wise / group-wise) ----------------
import hashlib, base64, io

q("""IF OBJECT_ID('cam_status','U') IS NULL CREATE TABLE cam_status(
  store_id INT, ch INT, online BIT, checked DATETIME2, PRIMARY KEY(store_id, ch))""")
q("""IF OBJECT_ID('store_status','U') IS NULL CREATE TABLE store_status(
  store_id INT PRIMARY KEY, reachable BIT, method NVARCHAR(30), err NVARCHAR(200), checked DATETIME2)""")
q("IF COL_LENGTH('cameras','cam_ip') IS NULL ALTER TABLE cameras ADD cam_ip VARCHAR(100) NULL")
for _t_ in ("cam_status", "store_status"):
    q(f"IF COL_LENGTH('{_t_}','offline_since') IS NULL ALTER TABLE {_t_} ADD offline_since DATETIME2 NULL")
    q(f"IF COL_LENGTH('{_t_}','last_online') IS NULL ALTER TABLE {_t_} ADD last_online DATETIME2 NULL")

def _outage(up, old_up, old_since, old_last, now):
    """(offline_since, last_online): band hone ka pehla samay purani jaanch se yaad rakhta hai."""
    if up: return None, now
    return ((old_since if old_up is False and old_since else None) or now), old_last

def _save_ips(sid, ips):
    for ch, ip in ips.items(): q("update cameras set cam_ip=? where store_id=? and ch=?", (ip, sid, ch))
REPORT = {"running": False, "done": 0, "total": 0, "started": None, "finished": None}

async def rtsp_describe(ip, port, user, pw, ch):
    """Camera ki sub-stream par RTSP DESCRIBE. (code, trace) lautata hai; 200 = camera chal raha hai."""
    url = f"rtsp://{ip}:{port}/Streaming/Channels/{ch}02"
    md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
    async def ask(auth=None):
        rd, wr = await asyncio.wait_for(asyncio.open_connection(ip, port), 5)
        try:
            msg = f"DESCRIBE {url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: cctvhub\r\n" + (f"Authorization: {auth}\r\n" if auth else "") + "\r\n"
            wr.write(msg.encode()); await wr.drain()
            buf = b""
            while b"\r\n\r\n" not in buf and len(buf) < 8192:
                chunk = await asyncio.wait_for(rd.read(2048), 10)
                if not chunk: break
                buf += chunk
            return buf.decode(errors="ignore")
        finally:
            wr.close()
    def code(t):
        m = re.match(r"RTSP/1\.\d (\d+)", t); return int(m.group(1)) if m else 0
    def line(t):
        m = re.search(r"WWW-Authenticate:[^\r\n]*", t, re.I); return (t.split("\r\n")[0] + " | " + (m.group(0)[:110] if m else "")).strip(" |")
    trace = []
    try:
        t = await ask(); trace.append(line(t))
        if code(t) == 401:
            realm = re.search(r'realm="([^"]*)"', t); nonce = re.search(r'nonce="([^"]*)"', t)
            if realm and nonce:
                ha1 = md5(f"{user}:{realm.group(1)}:{pw}"); ha2 = md5(f"DESCRIBE:{url}")
                if re.search(r'qop="?[^",]*auth', t):
                    cn = uuid.uuid4().hex[:16]; nc = "00000001"
                    resp = md5(f"{ha1}:{nonce.group(1)}:{nc}:{cn}:auth:{ha2}")
                    extra = f', qop=auth, nc={nc}, cnonce="{cn}"'
                else:
                    resp = md5(f"{ha1}:{nonce.group(1)}:{ha2}"); extra = ""
                t = await ask(f'Digest username="{user}", realm="{realm.group(1)}", nonce="{nonce.group(1)}", uri="{url}", response="{resp}"{extra}')
                trace.append("digest -> " + line(t))
            if code(t) == 401:
                t = await ask("Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()); trace.append("basic -> " + line(t))
        return code(t), trace
    except Exception as e:
        return 0, trace + [f"{type(e).__name__} {str(e)[:60]}"]

async def rtsp_ok(ip, port, user, pw, ch):
    return (await rtsp_describe(ip, port, user, pw, ch))[0] == 200

def _save_status(sid, reachable, method, err, chs, status):
    now = datetime.now()
    old = {r["ch"]: r for r in q("select ch, online, offline_since, last_online from cam_status where store_id=?", (sid,))}
    oss = q("select reachable, offline_since, last_online from store_status where store_id=?", (sid,))
    q("delete from cam_status where store_id=?", (sid,))
    for c in chs:
        o, up = old.get(c), bool(status.get(c))
        since, last = _outage(up, (bool(o["online"]) if o else None), o and o["offline_since"], o and o["last_online"], now)
        q("insert into cam_status(store_id,ch,online,checked,offline_since,last_online) values(?,?,?,?,?,?)", (sid, c, 1 if up else 0, now, since, last))
    p = oss[0] if oss else None
    since, last = _outage(bool(reachable), (bool(p["reachable"]) if p else None), p and p["offline_since"], p and p["last_online"], now)
    q("delete from store_status where store_id=?", (sid,))
    q("insert into store_status(store_id,reachable,method,err,checked,offline_since,last_online) values(?,?,?,?,?,?,?)",
      (sid, 1 if reachable else 0, method, err[:200], now, since, last))

async def check_store(s):
    chs = [c["ch"] for c in q("select ch from cameras where store_id=?", (s["id"],))]
    pw = fernet.decrypt(s["pw"].encode()).decode()
    reachable, status, method, err = await ping(s), {}, "", ""
    if reachable and chs:
        try:   # 1) NVR se hi poochho: kaun-kaun se IP camera online hain
            async with _nvr(s) as h:
                resp = await h.get(_base(s) + "/ISAPI/ContentMgmt/InputProxy/channels/status")
                resp.raise_for_status()
            for blk in re.findall(r"<InputProxyChannelStatus\b[^>]*>(.*?)</InputProxyChannelStatus>", resp.text, re.S | re.I):
                i = re.search(r"<id>(\d+)</id>", blk); o = re.search(r"<online>(.*?)</online>", blk)
                if i and o: status[int(i.group(1))] = o.group(1).strip().lower() == "true"
            method = "isapi"
        except Exception as e:
            err = f"{type(e).__name__} {str(e)[:80]}"
        try:   # camera ka apna IP (NVR ki channel list se)
            async with _nvr(s) as h:
                rc = await h.get(_base(s) + "/ISAPI/ContentMgmt/InputProxy/channels"); rc.raise_for_status()
            ips = {}
            for blk in re.findall(r"<InputProxyChannel\b[^>]*>(.*?)</InputProxyChannel>", rc.text, re.S | re.I):
                i = re.search(r"<id>(\d+)</id>", blk); ip = re.search(r"<ipAddress>(.*?)</ipAddress>", blk, re.I)
                if i and ip: ips[int(i.group(1))] = ip.group(1).strip()
            if ips: await asyncio.to_thread(_save_ips, s["id"], ips)
        except Exception:
            pass
        missing = [c for c in chs if not status.get(c)]   # jo NVR ne online nahi bataye unhe RTSP se dobara jaanchein
        if missing:   # 2) jinki jaankari nahi mili unhe RTSP se jaanchein
            sem = asyncio.Semaphore(4)
            async def one(c):
                async with sem: status[c] = await rtsp_ok(s["ip"], s["port"], s["username"], pw, c)
            await asyncio.gather(*(one(c) for c in missing))
            method = (method + "+rtsp") if method else "rtsp"
    await asyncio.to_thread(_save_status, s["id"], reachable, method, err, chs, status)

async def _run_report():
    stores = q("select * from stores")
    REPORT.update(running=True, done=0, total=len(stores), started=datetime.now(), finished=None)
    sem = asyncio.Semaphore(10)
    async def one(s):
        async with sem:
            try: await check_store(s)
            except Exception: pass
            REPORT["done"] += 1
    await asyncio.gather(*(one(s) for s in stores))
    REPORT.update(running=False, finished=datetime.now())

@app.post("/api/report/run", dependencies=[Depends(admin)])
async def report_run():
    if not REPORT["running"]:
        REPORT["running"] = True
        t = asyncio.create_task(_run_report()); TASKS.add(t); t.add_done_callback(TASKS.discard)
    return REPORT

@app.get("/api/report/status")
def report_status(): return REPORT

def _report_data():
    stores = q("""select s.id,s.name,s.city,s.zone,s.ip,s.http_port,
      (select count(*) from cameras where store_id=s.id) as total,
      (select count(*) from cam_status cs join cameras c on c.store_id=cs.store_id and c.ch=cs.ch
         where cs.store_id=s.id and cs.online=1) as live,
      ss.reachable, ss.checked, ss.method, ss.offline_since, ss.last_online
      from stores s left join store_status ss on ss.store_id=s.id order by s.name""")
    groups = q("""select g.id,g.name,
      (select count(*) from cam_group_items i where i.group_id=g.id) as total,
      (select count(*) from cam_group_items i join cam_status cs on cs.store_id=i.store_id and cs.ch=i.ch
         where i.group_id=g.id and cs.online=1) as live,
      (select count(*) from cam_group_items i join cam_status cs on cs.store_id=i.store_id and cs.ch=i.ch
         where i.group_id=g.id) as checked
      from cam_groups g order by g.name""")
    offline = q("""select s.id as store_id, s.name as store, s.ip, s.http_port, c.ch, c.name, c.cam_ip, cs.checked, cs.offline_since, cs.last_online, ss.reachable,
      (select string_agg(g.name, ', ') from cam_group_items i join cam_groups g on g.id=i.group_id
         where i.store_id=c.store_id and i.ch=c.ch) as grps
      from cameras c join stores s on s.id=c.store_id
      join cam_status cs on cs.store_id=c.store_id and cs.ch=c.ch
      left join store_status ss on ss.store_id=c.store_id
      where cs.online=0 order by s.name, c.ch""")
    return {"stores": stores, "groups": groups, "offline": offline}

@app.get("/api/report")
def report(): return {**_report_data(), "status": REPORT}

def _pct(l, t): return round(l * 100 / t) if t else 0
def _t(x): return str(x)[:16] if x else ""

def _xlsx_bytes(d):
    from openpyxl import Workbook
    from openpyxl.styles import Font
    wb = Workbook(); ws = wb.active; ws.title = "Store-wise"
    ws.append(["Store", "City", "Zone", "NVR", "Total cameras", "Live", "Offline", "Live %", "Last checked", "NVR IP", "NVR offline since"])
    for s in d["stores"]:
        ck = bool(s["checked"])
        ws.append([s["name"], s["city"], s["zone"], ("Online" if s["reachable"] else "OFFLINE") if ck else "Not checked", s["total"],
                   s["live"] if ck else "", (s["total"] - s["live"]) if ck else "", _pct(s["live"], s["total"]) if ck else "", _t(s["checked"]), s["ip"], _t(s["offline_since"]) if ck and not s["reachable"] else ""])
    ws2 = wb.create_sheet("Group-wise"); ws2.append(["Group", "Total cameras", "Live", "Offline", "Live %"])
    for g in d["groups"]:
        ws2.append([g["name"], g["total"], g["live"], g["checked"] - g["live"], _pct(g["live"], g["checked"])])
    ws3 = wb.create_sheet("Offline cameras"); ws3.append(["Store", "Channel", "Camera", "Group", "NVR reachable", "Last checked", "NVR IP", "Camera IP", "Offline since", "Last seen online"])
    for o in d["offline"]:
        ws3.append([o["store"], o["ch"], o["name"], o["grps"] or "", "Yes" if o["reachable"] else "No", _t(o["checked"]), o["ip"], o["cam_ip"] or "", _t(o["offline_since"]), _t(o["last_online"])])
    for w in wb.worksheets:
        for c in w[1]: c.font = Font(bold=True)
        w.freeze_panes = "A2"
        for col in w.columns: w.column_dimensions[col[0].column_letter].width = min(40, max(len(str(c.value or "")) for c in col) + 3)
    buf = io.BytesIO(); wb.save(buf); return buf.getvalue()

@app.get("/api/report.xlsx")
def report_xlsx():
    try: data = _xlsx_bytes(_report_data())
    except ImportError: raise HTTPException(500, "openpyxl install karein: venv\\\\Scripts\\\\pip install openpyxl")
    name = f"camera_report_{datetime.now():%Y%m%d_%H%M}.xlsx"
    return StreamingResponse(io.BytesIO(data), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})

REPORT_EVERY = int(os.getenv("REPORT_EVERY_MIN", "0"))   # 0 = sirf button dabane par; 30 = har 30 minute me apne aap

@app.on_event("startup")
async def _report_scheduler():
    async def loop():
        await asyncio.sleep(30)
        while True:
            if not REPORT["running"]: await _run_report()
            await asyncio.sleep(REPORT_EVERY * 60)
    if REPORT_EVERY > 0:
        t = asyncio.create_task(loop()); TASKS.add(t)


import time

@app.get("/api/vodtest")
async def vodtest(store_id: int, ch: int, start: str, off: int = None, seconds: int = 5):
    """NVR se recording kitni tezi se utarti hai (asli gati ke kitne guna) - tez playback ki limit batata hai."""
    r = _cam(store_id, ch); off = PB_OFFSET if off is None else off
    t0 = datetime.strptime(start, "%Y-%m-%dT%H:%M:%S") - timedelta(minutes=off)
    body = await _vod_body(r, ch, t0, t0 + timedelta(seconds=max(5, min(seconds, 30))))
    secs = max(5, min(seconds, 30)); st = {"got": 0, "first": None}; t_req = time.perf_counter()
    async def pull():
        async with _nvr(r) as h:
            async with h.stream("POST", _base(r) + "/ISAPI/ContentMgmt/download", content=body, headers={"Content-Type": "application/xml"}) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(1 << 18):
                    if st["first"] is None: st["first"] = time.perf_counter()
                    st["got"] += len(chunk)
    try:
        await asyncio.wait_for(pull(), 15)
    except asyncio.TimeoutError:     # 15 second me bhi itna chhota clip nahi utra = network bahut dheema
        return {"x": round(secs / 15, 1), "mbps": round(st["got"] * 8 / 1e6 / 15, 1), "mbyte": round(st["got"] / 1e6, 1), "latency": 15, "slow": True}
    except Exception as e:
        raise HTTPException(502, f"download test fail: {type(e).__name__} {str(e)[:80]}")
    got, t_first = st["got"], st["first"]
    t_end = time.perf_counter()
    if not got or t_first is None: raise HTTPException(404, "download me data nahi aaya")
    flow = max(t_end - t_first, 0.05)
    return {"x": round(secs / max(t_end - t_req, 0.05), 1), "mbps": round(got * 8 / 1e6 / flow, 1),
            "mbyte": round(got / 1e6, 1), "latency": round(t_first - t_req, 1)}


@app.get("/api/report/debug", dependencies=[Depends(admin)])
async def report_debug(store_id: int, ch: int = 1):
    """Report galat lage to: ek store/camera ki jaanch ka kaccha nateeja dikhata hai."""
    s = get_store(store_id); pw = fernet.decrypt(s["pw"].encode()).decode()
    out = {"store": s["name"], "ip": s["ip"], "port": s["port"], "http_port": s["http_port"], "channel": ch, "tcp_ok": await ping(s)}
    try:
        async with _nvr(s) as h:
            r = await h.get(_base(s) + "/ISAPI/ContentMgmt/InputProxy/channels/status")
        out["isapi_status"] = {"code": r.status_code, "body": r.text[:900]}
    except Exception as e:
        out["isapi_status"] = {"error": f"{type(e).__name__} {str(e)[:120]}"}
    code, trace = await rtsp_describe(s["ip"], s["port"], s["username"], pw, ch)
    out["rtsp_sub_stream"] = {"code": code, "steps": trace}
    return out


@app.post("/api/cam/open")
async def cam_open(store_id: int, ch: int):
    """Sirf ek camera ke stream taiyaar karo (alag window me live dekhne ke liye)."""
    _cam(store_id, ch)
    return await register(q(CAM_SQL + "where c.store_id=? and c.ch=?", (store_id, ch)))


# ---------------- Users (admin / viewer) ----------------
from pydantic import BaseModel

class UserReq(BaseModel):
    username: str
    password: str = ""
    role: str = "viewer"
    can_groups: bool = False

@app.get("/api/users", dependencies=[Depends(admin)])
def users(): return q("select username, role, can_groups, created from app_users order by username")

@app.post("/api/users", dependencies=[Depends(admin)])
def user_set(req: UserReq):
    name = req.username.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{3,50}", name): raise HTTPException(400, "Naam me sirf English akshar, ank aur . _ - @ hon (3 se 50)")
    if req.role not in ("viewer", "admin"): raise HTTPException(400, "role galat hai")
    if name.lower() == APP_USER.lower(): raise HTTPException(400, "Yeh naam main admin ka hai")
    cg = 1 if req.can_groups else 0
    if req.password:
        if len(req.password) < 8: raise HTTPException(400, "Password kam se kam 8 akshar ka rakhein")
        h = _hash(req.password)
        if q("update app_users set pw_hash=?, role=?, can_groups=? where username=?", (h, req.role, cg, name)) == 0:
            q("insert into app_users(username,pw_hash,role,can_groups,created) values(?,?,?,?,?)", (name, h, req.role, cg, datetime.now()))
    elif q("update app_users set role=?, can_groups=? where username=?", (req.role, cg, name)) == 0:
        raise HTTPException(400, "Naye user ke liye password zaroori hai")
    _AUTHC.clear(); return {"ok": True}

@app.delete("/api/users/{name}", dependencies=[Depends(admin)])
def user_del(name: str):
    q("delete from app_users where username=?", (name,)); _AUTHC.clear(); return {"ok": True}

# ---------------- go2rtc proxy: browser sirf 8000 se baat kare, go2rtc (1984) sirf is PC par khula rahe ----------------
import websockets
GO2RTC_WS = "ws" + GO2RTC[4:]
_WSKEY = (os.environ["FERNET_KEY"] + "-ws").encode()

def _wstok_new():
    exp = str(int(time.time()) + 12 * 3600)
    return exp + "." + hmac.new(_WSKEY, exp.encode(), "sha256").hexdigest()[:32]

def _wstok_ok(t):
    try:
        exp, sig = t.split(".")
        return int(exp) > time.time() and hmac.compare_digest(sig, hmac.new(_WSKEY, exp.encode(), "sha256").hexdigest()[:32])
    except Exception:
        return False

@app.get("/api/wstoken")
def wstoken(): return {"t": _wstok_new()}

@app.get("/g/{name}")
async def g_static(name: str):
    if name not in ("video-stream.js", "video-rtc.js"): raise HTTPException(404)
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.get(f"{GO2RTC}/{name}")
    return Response(r.content, media_type="text/javascript")

@app.websocket("/g/api/ws")
async def g_ws(ws: WebSocket, src: str, t: str = ""):
    if not _wstok_ok(t) or not re.fullmatch(r"[\w\-]+", src):
        await ws.close(code=1008); return
    await ws.accept()
    try:
        async with websockets.connect(f"{GO2RTC_WS}/api/ws?src={src}", max_size=None, open_timeout=10) as up:
            async def c2u():
                while True:
                    m = await ws.receive()
                    if m["type"] == "websocket.disconnect": break
                    if m.get("text") is not None: await up.send(m["text"])
                    elif m.get("bytes") is not None: await up.send(m["bytes"])
            async def u2c():
                async for m in up:
                    if isinstance(m, bytes): await ws.send_bytes(m)
                    else: await ws.send_text(m)
            t1, t2 = asyncio.create_task(c2u()), asyncio.create_task(u2c())
            await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
            t1.cancel(); t2.cancel()
    except Exception:
        pass
    finally:
        try: await ws.close()
        except Exception: pass
