# Runbook: ffmpeg for fast playback (P4-L2)

Applies to: CityKart Drishti, the web process (`npm run dev` / the later Windows service). Written 2026-10-23 with P4-L2 (decision D-L1:
fast playback 2x-16x is part of `cctv.playback`, delivered only as a browser stream; `docs/drishti/ARCHITECTURE.md` section 6.5).

**Status: real transcoding/remuxing is UNVALIDATED.** ffmpeg is not installed on the development PC. Everything that runs ffmpeg was
tested with a stand-in process (`tests/helpers/fake-ffmpeg.mjs`) and a fake remux adapter (`tests/helpers/fake-remux.ts`); the
real-ffmpeg tests (`tests/integration/vod.test.ts` "turns the NVR download into a fragmented MP4 …" and
`tests/integration/fast-playback.test.ts` "real ffmpeg (skipped when ffmpeg is not installed …)") are skipped on this PC and run by
themselves once `ffmpeg -version` works. A real Hikvision NVR download has never been remuxed (external dependency 2).

## What ffmpeg does here

- The NVR sends a recording (`/ISAPI/ContentMgmt/download`) much faster than it plays. The remux adapter (`lib/streams/remux.ts`, real
  one `ffmpegRemux` → `lib/streams/ffmpeg.ts`) pipes it through `ffmpeg -c:v copy` into a fragmented MP4 — a **remux, never a re-encode**
  (ruling E-2). Arguments: `-nostdin -loglevel error -protocol_whitelist pipe -format_whitelist mpeg,mpegts,mov,mp4,h264,hevc -i pipe:0
  -an -c:v copy [-tag:v hvc1] -movflags frag_keyframe+empty_moov+default_base_moof -flush_packets 1 -f mp4 pipe:1`. No shell, no file, no
  network address can be opened by it.
- Used by: fast playback (`/api/playback/stream`, cctv.playback) and the saveable file (`/api/vod`, cctv.export, administrators only).
  1x playback and live video do not need it (go2rtc).
- Limits: 1 running conversion per person (a new one ends the previous one), 8 in all per web process; killed when the page closes, after
  29.5 minutes, after 60 s without NVR data, or when the person's access goes (re-checked every 15 s).
- Without a working ffmpeg the Playback screen offers 1x only and says "Fast playback is not set up on this server."

## Install (Windows server or the development PC) — done by whoever runs the server, not by a builder

1. Download a current static **release** build of ffmpeg for Windows x64 from a source your IT policy trusts (for example the "release
   essentials" build linked from <https://ffmpeg.org/download.html#build-windows>). Check the published SHA-256 of the archive.
2. Unpack it to a fixed folder that only administrators can write, for example `C:\Program Files\ffmpeg\` (so the program is
   `C:\Program Files\ffmpeg\bin\ffmpeg.exe`). Do not put it in the repository or a user's Downloads folder.
3. Tell Drishti where it is — EITHER:
   - set `FFMPEG` to the **full path** of the program in the web process's environment (for development: a line
     `FFMPEG=C:\Program Files\ffmpeg\bin\ffmpeg.exe` in `.env.local`). A relative path or anything that is not a full path on one line is
     refused with "FFMPEG must be the full path of the ffmpeg program." and fast playback stays off; OR
   - put `C:\Program Files\ffmpeg\bin` on the machine's PATH (only full-path PATH entries are searched; `.` and relative entries never).
4. Restart the web process (the "is ffmpeg there" answer is remembered for one minute).
5. Check: `"C:\Program Files\ffmpeg\bin\ffmpeg.exe" -version` prints a version. On the Playback screen the Speed list now offers
   2x, 4x, 8x and 16x.
6. Validate, once, and record the result in `docs/drishti/DELIVERY-STATUS.md` (Evidence log; rows LG-14, LG-15, LG-18, CC-3):
   - `npx vitest run tests/integration/fast-playback.test.ts tests/integration/vod.test.ts` — the two real-ffmpeg tests now run (they
     are no longer listed as skipped) and must pass;
   - with the owner's permission and a monitoring-enabled NVR only (ruling R-1: read operations only), play one camera at 4x and 16x in
     Chrome and Edge, and note the NVR model, firmware, codec (H.264 / H.265), whether the picture starts, and the format ffmpeg
     reported. A real NVR that sends a container outside the whitelist answers "This recording's format is not supported for fast
     playback."; add its demuxer name to `FORMAT_WHITELIST` in `lib/streams/ffmpeg.ts` only after reviewing it.

## Not this runbook

- The H.265 → H.264 **transcode** option (libx264, per recorder, off by default, CPU/concurrency cap; ruling E-2) is a later release
  (P4-L5 / WP-4.4). Until then a browser that cannot play H.265 shows "This camera records in H.265, which this browser cannot play at a
  faster speed …".
- `FAST_PLAYBACK_REMUX=passthrough` is a development-only switch for browser checks against a fake NVR on this computer that already
  serves a fragmented MP4. It is ignored in production and refused for any NVR that is not on loopback; never set it on a server.
