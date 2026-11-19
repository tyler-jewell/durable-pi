#!/usr/bin/env python3
# Reporter bridge: every 5 min for 2h, read the Studio's download monitor and push the
# progress into apple-box App State (/model-downloads), so it's durable, visible in the
# hub UI and readable by any agent via read_state.
import json, os, re, subprocess, time, urllib.request

# Credentials and endpoint come from the environment — never hardcode tokens or device URLs.
TOKEN = os.environ.get("DPI_DEVICE_TOKEN", "")
URL = os.environ.get("DPI_APP_STATE_URL", "")
if not TOKEN or not URL:
    raise SystemExit("set DPI_DEVICE_TOKEN and DPI_APP_STATE_URL (the device's /demo/state endpoint)")
LOGFILE = os.path.expanduser("~/.dpi-mcp/report-progress.log")
TOTAL_GB = float(os.environ.get("DPI_DOWNLOAD_TOTAL_GB", "82.9"))
DURATION = 2 * 3600
INTERVAL = 300


def studio_line():
    r = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "studio", "tail -1 /tmp/dl-progress.log"],
        capture_output=True, text=True, timeout=20,
    )
    return (r.stdout or "").strip()


def post(pct, gb, eta):
    value = {"pct": pct, "gb": gb, "total_gb": TOTAL_GB, "eta_min": eta}
    body = json.dumps({"operation": "update", "path": "/model-downloads", "value": value}).encode()
    req = urllib.request.Request(
        URL, data=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=15)


def log(msg):
    os.makedirs(os.path.dirname(LOGFILE), exist_ok=True)
    with open(LOGFILE, "a") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")


log("reporter start: every 5 min for 2h, Studio -> apple-box App State /model-downloads")
start = time.time()
while time.time() - start < DURATION:
    time.sleep(INTERVAL)
    line = studio_line()
    m_pct = re.search(r"([0-9.]+)%", line)
    m_gb = re.search(r"([0-9.]+)/([0-9.]+)", line)
    m_eta = re.search(r"ETA ([0-9]+) min", line)
    if not m_pct or not m_gb:
        log("no progress line yet; skipping")
        continue
    pct = float(m_pct.group(1))
    gb = float(m_gb.group(1))
    eta = int(m_eta.group(1)) if m_eta else None
    try:
        post(pct, gb, eta)
        log(f"reported pct={pct:.1f}% gb={gb:.2f}/{TOTAL_GB} eta={eta} min -> App State")
        if pct >= 100:
            log("downloads complete; reporter stopping")
            break
    except Exception as e:
        log(f"FAILED to report ({e})")
log("reporter done")
