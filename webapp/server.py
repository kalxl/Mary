"""Local web UI backend for the AIO Webtoon Downloader.

Run with:
    uvicorn webapp.server:app --reload --port 8000
"""

from __future__ import annotations

import logging
import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
import ipaddress
import socket
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple
from urllib.parse import urlparse, quote

# cloudscraper is optional; fall back to requests.Session when unavailable
try:  # pragma: no cover - optional dependency
    import cloudscraper  # type: ignore
except Exception:  # pragma: no cover
    cloudscraper = None

import requests

from fastapi import FastAPI, HTTPException, Response, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.types import Scope

from sites.asura import AsuraSiteHandler
from sites.mangataro import MangataroSiteHandler
from sites.comix import ComixSiteHandler


logger = logging.getLogger(__name__)


REPO_ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = REPO_ROOT / "webapp" / "static"
SCRIPT_PATH = REPO_ROOT / "downloader" / "main.py"

_data_root_env = (os.environ.get("ARY_DATA_DIR") or "").strip()
DATA_ROOT = Path(_data_root_env).expanduser() if _data_root_env else None
COMICS_DIR = (DATA_ROOT / "comics") if DATA_ROOT else (REPO_ROOT / "comics")
COMICK_API_BASES = (
    "https://api.comick.dev",
)
COMICK_API = COMICK_API_BASES[0]
COMICK_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://comick.dev/",
}
ASURA_BASE = "https://asuracomic.net"
ASURA_HANDLER = AsuraSiteHandler()
MANGATARO_BASE = "https://mangataro.org"
MANGATARO_HANDLER = MangataroSiteHandler()
COMIX_BASE = "https://comix.to"
COMIX_HANDLER = ComixSiteHandler()
USER_SETTINGS_FILE = (DATA_ROOT / "user_settings.json") if DATA_ROOT else (REPO_ROOT / "webapp" / "user_settings.json")
LIST_DIR = (DATA_ROOT / "list") if DATA_ROOT else (REPO_ROOT / "list")
REPO_LIST_DIR = REPO_ROOT / "list"
SERIES_MAP_FILE = LIST_DIR / "series"
SERVER_JSON_FILE = LIST_DIR / "server.json"
_USER_SETTINGS_LOCK = threading.Lock()
_SERIES_MAP_LOCK = threading.Lock()
_DEFAULT_USER_SETTINGS = {
    "slugs": {
        "asura": {},
        "mangataro": {},
    },
    "cookies": {
        "mangataro": "",
    },
}

_RECOMMENDATION_CACHE: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
_RECOMMENDATION_CACHE_TTL = 300  # seconds

# ---------------------------------------------------------------------------
# Proxy config — set COMIX_PROXY env var to route comix.to through a proxy.
# Example: http://user:pass@p.webshare.io:80
# ---------------------------------------------------------------------------
COMIX_PROXY = os.environ.get("COMIX_PROXY", "").strip()
COMIX_CF_CLEARANCE = os.environ.get("COMIX_CF_CLEARANCE", "").strip()


def _clone_default_settings() -> Dict[str, Dict[str, Dict]]:
    return json.loads(json.dumps(_DEFAULT_USER_SETTINGS))


def _ensure_user_settings_file() -> None:
    USER_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not USER_SETTINGS_FILE.exists():
        USER_SETTINGS_FILE.write_text(json.dumps(_DEFAULT_USER_SETTINGS, indent=2), encoding="utf-8")


def _load_user_settings() -> Dict[str, Any]:
    with _USER_SETTINGS_LOCK:
        try:
            _ensure_user_settings_file()
            with USER_SETTINGS_FILE.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            data = _clone_default_settings()
            USER_SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        if not isinstance(data, dict):
            return _clone_default_settings()
        data.setdefault("slugs", {})
        data["slugs"].setdefault("asura", {})
        data["slugs"].setdefault("mangataro", {})
        data.setdefault("cookies", {})
        data["cookies"].setdefault("mangataro", "")
        return data


def _save_user_settings(data: Dict[str, Any]) -> None:
    with _USER_SETTINGS_LOCK:
        USER_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        USER_SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _update_user_settings(payload: UserSettingsPayload) -> Dict[str, Any]:
    settings = _load_user_settings()
    if payload.asura_slugs:
        settings.setdefault("slugs", {}).setdefault("asura", {}).update(payload.asura_slugs)
    if payload.mangataro_slugs:
        settings.setdefault("slugs", {}).setdefault("mangataro", {}).update(payload.mangataro_slugs)
    if payload.mangataro_cookies is not None:
        settings.setdefault("cookies", {})["mangataro"] = payload.mangataro_cookies
    _save_user_settings(settings)
    return settings


def _load_asura_cover_map() -> Dict[str, str]:
    """Loads list/asurascans_slugs.txt in slug|cover format."""
    path = LIST_DIR / "asurascans_slugs.txt"
    if not path.exists():
        repo_fallback = REPO_LIST_DIR / "asurascans_slugs.txt"
        if repo_fallback.exists():
            path = repo_fallback
    out: Dict[str, str] = {}
    if not path.exists():
        return out
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = (raw or "").strip()
            if not line:
                continue
            if "|" not in line:
                continue
            slug, cover = line.split("|", 1)
            slug = slug.strip()
            cover = cover.strip()
            if not slug or not cover:
                continue
            out[slug] = cover
    except Exception:
        return {}
    return out


def _load_asura_series_index() -> Dict[str, Dict[str, Any]]:
    path = STATIC_DIR / "series.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        return {}
    return {}


def _upsert_series_map_line(*, comick_slug: str, asura_slug: str) -> None:
    cs = (comick_slug or "").strip()
    a = (asura_slug or "").strip()
    if not cs or not a:
        raise ValueError("Missing slugs")

    with _SERIES_MAP_LOCK:
        LIST_DIR.mkdir(parents=True, exist_ok=True)
        existing: List[str] = []
        if SERIES_MAP_FILE.exists():
            try:
                existing = SERIES_MAP_FILE.read_text(encoding="utf-8").splitlines()
            except Exception:
                existing = []

        out: List[str] = []
        replaced = False
        for raw in existing:
            line = (raw or "").strip()
            if not line:
                continue
            if "|" in line:
                left, _right = line.split("|", 1)
                if left.strip() == cs:
                    out.append(f"{cs}|{a}")
                    replaced = True
                else:
                    out.append(line)
            else:
                out.append(line)
        if not replaced:
            out.append(f"{cs}|{a}")

        SERIES_MAP_FILE.write_text("\n".join(out) + "\n", encoding="utf-8")


def _load_server_json() -> Dict[str, Any]:
    if not SERVER_JSON_FILE.exists():
        data = {
            "version": 1,
            "series": {},
        }
        try:
            _save_server_json(data)
        except Exception:
            pass
        return data
    try:
        data = json.loads(SERVER_JSON_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"version": 1, "series": {}}
        data.setdefault("version", 1)
        data.setdefault("series", {})
        if not isinstance(data["series"], dict):
            data["series"] = {}
        return data
    except Exception:
        return {"version": 1, "series": {}}


def _save_server_json(data: Dict[str, Any]) -> None:
    LIST_DIR.mkdir(parents=True, exist_ok=True)
    SERVER_JSON_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _upsert_server_json_mapping(*, comick_slug: str, source: str, slug: str) -> None:
    cs = (comick_slug or "").strip()
    src = (source or "").strip().lower()
    s = (slug or "").strip()
    if not cs or not src or not s:
        raise ValueError("Missing mapping fields")

    with _SERIES_MAP_LOCK:
        data = _load_server_json()
        series = data.setdefault("series", {})
        if not isinstance(series, dict):
            series = {}
            data["series"] = series
        entry = series.get(cs)
        if not isinstance(entry, dict):
            entry = {}
            series[cs] = entry
        sources = entry.get("sources")
        if not isinstance(sources, dict):
            sources = {}
            entry["sources"] = sources

        sources[src] = s
        entry["updated_at"] = datetime.utcnow().isoformat() + "Z"
        _save_server_json(data)


class SeriesMapPayload(BaseModel):
    comick_slug: str = Field(..., min_length=1)
    asura_slug: str = Field(..., min_length=1)


def _create_scraper(*, use_cloudflare: bool = False) -> requests.Session:
    if use_cloudflare and cloudscraper is not None:
        try:
            return cloudscraper.create_scraper(
                browser={"browser": "chrome", "platform": "windows", "mobile": False}
            )
        except Exception:
            pass
    return requests.Session()


def _create_comix_scraper() -> requests.Session:
    """Creates a session for comix.to requests, routing through COMIX_PROXY if set,
    and injecting cf_clearance cookie if COMIX_CF_CLEARANCE is set."""
    session = requests.Session()
    session.headers.update({
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://comix.to/",
        "Origin": "https://comix.to",
        "Connection": "keep-alive",
    })
    if COMIX_PROXY:
        session.proxies = {
            "http": COMIX_PROXY,
            "https": COMIX_PROXY,
        }
    if COMIX_CF_CLEARANCE:
        session.cookies.set("cf_clearance", COMIX_CF_CLEARANCE, domain=".comix.to")
    return session


def _simple_request(target, scraper: requests.Session):
    if isinstance(target, tuple):
        url, params = target
        resp = scraper.get(url, params=params, timeout=20)
    else:
        resp = scraper.get(target, timeout=20)
    resp.raise_for_status()
    return resp


def _is_retryable_http_error(exc: Exception) -> bool:
    if isinstance(exc, (requests.Timeout, requests.ConnectionError)):
        return True
    if isinstance(exc, requests.HTTPError):
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
        if status in (502, 503, 504):
            return True
    return False


def _simple_request_with_retries(
    target,
    scraper: requests.Session,
    *,
    attempts: int = 3,
    base_delay: float = 0.6,
):
    last_exc: Optional[Exception] = None
    for idx in range(max(1, attempts)):
        try:
            return _simple_request(target, scraper)
        except Exception as exc:  # pragma: no cover - network dependent
            last_exc = exc
            if idx >= attempts - 1 or not _is_retryable_http_error(exc):
                raise
            time.sleep(base_delay * (2**idx))
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Request failed")


def _parse_cookie_header(header_value: Optional[str]) -> Dict[str, str]:
    cookies: Dict[str, str] = {}
    if not header_value:
        return cookies
    for part in header_value.split(";"):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        value = value.strip()
        if name:
            cookies[name] = value
    return cookies


def _apply_mangataro_cookies(scraper: requests.Session, header_value: Optional[str]) -> None:
    cookies = _parse_cookie_header(header_value)
    if not cookies:
        return
    for name, value in cookies.items():
        scraper.cookies.set(name, value, domain="mangataro.org")


class DownloadRequest(BaseModel):
    comic_url: str = Field(..., alias="url", description="Full URL to the series page")
    site: Optional[str] = Field(None, description="Optional explicit site handler")
    chapters: str = Field("all", description="Chapters filter (e.g. 'all', '1-10', '1,3,5-7')")
    language: str = Field("en", description="Language code")
    format: Literal["epub", "pdf", "cbz", "none"] = Field("epub")
    epub_layout: Literal["vertical", "page"] = Field("vertical")
    keep_images: bool = False
    keep_chapters: bool = False
    no_processing: bool = False
    group: List[str] = Field(default_factory=list, description="Preferred scanlation groups")
    mix_by_upvote: bool = False
    no_partials: bool = False
    cookies: str = Field("", description="Cookie string (key=value; key2=value2)")

    class Config:
        populate_by_name = True


class DownloadStatus(BaseModel):
    id: str
    url: str
    format: str
    status: Literal["queued", "running", "success", "error"]
    started_at: datetime
    finished_at: Optional[datetime] = None
    message: Optional[str] = None
    log: str = ""


@dataclass
class _Task:
    request: DownloadRequest
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: str = "queued"
    log: List[str] = field(default_factory=list)
    started_at: datetime = field(default_factory=datetime.utcnow)
    finished_at: Optional[datetime] = None
    message: Optional[str] = None


class DownloadManager:
    def __init__(self) -> None:
        self._tasks: Dict[str, _Task] = {}
        self._lock = threading.Lock()

    def start_download(self, payload: DownloadRequest) -> str:
        task = _Task(request=payload)
        with self._lock:
            self._tasks[task.id] = task

        thread = threading.Thread(target=self._run_task, args=(task,), daemon=True)
        thread.start()
        return task.id

    def list_status(self) -> List[DownloadStatus]:
        with self._lock:
            return [self._to_status(task) for task in self._tasks.values()]

    def get_status(self, task_id: str) -> DownloadStatus:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                raise KeyError(task_id)
            return self._to_status(task)

    def _run_task(self, task: _Task) -> None:
        cmd = self._build_command(task.request)
        task.status = "running"
        task.started_at = datetime.utcnow()

        process = subprocess.Popen(
            cmd,
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        assert process.stdout is not None
        for line in process.stdout:
            stripped = line.rstrip()
            with self._lock:
                task.log.append(stripped)

        return_code = process.wait()
        with self._lock:
            task.finished_at = datetime.utcnow()
            if return_code == 0:
                task.status = "success"
                task.message = "Completed"
            else:
                task.status = "error"
                task.message = f"Exited with code {return_code}"

    def _build_command(self, payload: DownloadRequest) -> List[str]:
        exe = sys.executable
        args: List[str] = [exe, str(SCRIPT_PATH)]

        if payload.site:
            args.extend(["--site", payload.site])
        if payload.cookies:
            args.extend(["--cookies", payload.cookies])
        if payload.group:
            args.extend(["--group", *payload.group])
        if payload.mix_by_upvote:
            args.append("--mix-by-upvote")
        if payload.no_partials:
            args.append("--no-partials")

        args.extend(["--chapters", payload.chapters])
        args.extend(["--language", payload.language])
        args.extend(["--format", payload.format])
        args.extend(["--epub-layout", payload.epub_layout])

        if payload.keep_images:
            args.append("--keep-images")
        if payload.keep_chapters:
            args.append("--keep-chapters")
        if payload.no_processing:
            args.append("--no-processing")

        args.append(payload.comic_url)
        return args

    def _to_status(self, task: _Task) -> DownloadStatus:
        return DownloadStatus(
            id=task.id,
            url=task.request.comic_url,
            format=task.request.format,
            status=task.status,  # type: ignore[arg-type]
            started_at=task.started_at,
            finished_at=task.finished_at,
            message=task.message,
            log="\n".join(task.log[-500:]),
        )


class CachedStaticFiles(StaticFiles):
    def __init__(self, *args, cache_timeout: int = 3600, **kwargs):
        super().__init__(*args, **kwargs)
        self._cache_timeout = cache_timeout

    async def get_response(self, path: str, scope: Scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            if path.endswith((
                ".js", ".css", ".svg", ".png", ".jpg",
                ".jpeg", ".webp", ".gif", ".ico",
            )):
                response.headers["Cache-Control"] = f"public, max-age={self._cache_timeout}"
            else:
                response.headers.setdefault("Cache-Control", "no-cache")
        return response


manager = DownloadManager()
app = FastAPI(title="AIO Webtoon Downloader UI", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(GZipMiddleware, minimum_size=500)

if STATIC_DIR.exists():
    app.mount(
        "/static",
        CachedStaticFiles(directory=STATIC_DIR, html=True, cache_timeout=60 * 60 * 12),
        name="static",
    )


@app.get("/manifest.webmanifest")
def pwa_manifest() -> FileResponse:
    path = STATIC_DIR / "manifest.webmanifest"
    if not path.exists():
        raise HTTPException(status_code=404, detail="manifest not found")
    return FileResponse(path, media_type="application/manifest+json")


@app.get("/sw.js")
def pwa_service_worker() -> FileResponse:
    path = STATIC_DIR / "sw.js"
    if not path.exists():
        raise HTTPException(status_code=404, detail="service worker not found")
    return FileResponse(path, media_type="application/javascript")


@app.get("/", include_in_schema=False)
async def index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "Frontend not built"}


@app.get("/series.html", include_in_schema=False)
async def series_page():
    file_path = STATIC_DIR / "series.html"
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="series.html not found")


@app.get("/series", include_in_schema=False)
async def series_page_clean():
    return await series_page()


@app.get("/reader.html", include_in_schema=False)
async def reader_page():
    file_path = STATIC_DIR / "reader.html"
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="reader.html not found")


@app.get("/reader", include_in_schema=False)
async def reader_page_clean():
    return await reader_page()


@app.get("/browse.html", include_in_schema=False)
async def browse_page():
    file_path = STATIC_DIR / "browse.html"
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="browse.html not found")


@app.get("/browse", include_in_schema=False)
async def browse_page_clean():
    return await browse_page()


@app.get("/library.html", include_in_schema=False)
async def library_page():
    file_path = STATIC_DIR / "library.html"
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="library.html not found")


@app.get("/library", include_in_schema=False)
async def library_page_clean():
    return await library_page()


@app.get("/profile.html", include_in_schema=False)
async def profile_page():
    file_path = STATIC_DIR / "profile.html"
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="profile.html not found")


@app.get("/profile", include_in_schema=False)
async def profile_page_clean():
    return await profile_page()


@app.get("/downloads.html", include_in_schema=False)
async def downloads_page():
    file_path = STATIC_DIR / "downloads.html"
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="downloads.html not found")


@app.get("/downloads", include_in_schema=False)
async def downloads_page_clean():
    return await downloads_page()


@app.get("/game.html", include_in_schema=False)
async def game_page():
    file_path = STATIC_DIR / "game.html"
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="game.html not found")


@app.get("/game", include_in_schema=False)
async def game_page_clean():
    return await game_page()


@app.post("/api/downloads", response_model=DownloadStatus)
async def create_download(payload: DownloadRequest):
    if not SCRIPT_PATH.exists():
        raise HTTPException(status_code=500, detail="Downloader script not found")

    task_id = manager.start_download(payload)
    return manager.get_status(task_id)


@app.get("/api/downloads", response_model=List[DownloadStatus])
async def list_downloads():
    return manager.list_status()


@app.get("/api/downloads/{task_id}", response_model=DownloadStatus)
async def get_download(task_id: str):
    try:
        return manager.get_status(task_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Task not found")


def _scan_library() -> List[Dict[str, object]]:
    library: List[Dict[str, object]] = []
    if not COMICS_DIR.exists():
        return library

    for entry in sorted(COMICS_DIR.iterdir()):
        if entry.is_file():
            library.append(
                {
                    "name": entry.name,
                    "path": entry.name,
                    "updated_at": datetime.fromtimestamp(entry.stat().st_mtime),
                }
            )
            continue

        files = [str(p.relative_to(COMICS_DIR)) for p in entry.rglob("*") if p.is_file()]
        library.append(
            {
                "name": entry.name,
                "path": entry.name + "/",
                "files": files,
                "updated_at": datetime.fromtimestamp(entry.stat().st_mtime),
            }
        )
    return library


@app.get("/api/library")
async def list_library():
    return {"items": _scan_library()}


@app.get("/api/health")
async def healthcheck():
    return {"status": "ok", "has_downloader": SCRIPT_PATH.exists()}


@app.get("/api/asura/index")
async def asura_picker_index():
    index = _load_asura_series_index()
    cover_map = _load_asura_cover_map()
    out: List[Dict[str, Any]] = []
    for key, item in index.items():
        if not isinstance(item, dict):
            continue
        slug = str(item.get("slug") or key or "").strip()
        if not slug:
            continue
        title = str(item.get("title") or "").strip()
        cover = cover_map.get(slug) or ""
        out.append({"slug": slug, "title": title, "cover": cover})

    # Ensure all cover-map entries are present even if not in series.json.
    if cover_map:
        seen = {row["slug"] for row in out if row.get("slug")}
        for slug, cover in cover_map.items():
            if slug in seen:
                continue
            out.append({"slug": slug, "title": "", "cover": cover})

    out.sort(key=lambda r: (r.get("title") or r.get("slug") or "").lower())
    return out


@app.post("/api/series-map")
async def persist_series_map(payload: SeriesMapPayload):
    try:
        _upsert_series_map_line(comick_slug=payload.comick_slug, asura_slug=payload.asura_slug)
        _upsert_server_json_mapping(
            comick_slug=payload.comick_slug,
            source="asura",
            slug=payload.asura_slug,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("persist_series_map failed")
        raise HTTPException(status_code=500, detail=f"Failed to persist mapping: {exc}") from exc
    return {"ok": True}


@app.get("/api/series-map")
async def series_map_info():
    return {
        "ok": False,
        "message": "Use POST /api/series-map with JSON {comick_slug, asura_slug} to save a mapping.",
    }


@app.get("/api/img-proxy")
async def img_proxy(url: str = Query(..., min_length=8)):
    target = (url or "").strip()
    if not (target.startswith("http://") or target.startswith("https://")):
        raise HTTPException(status_code=400, detail="Invalid image URL")

    parsed = urlparse(target)
    if not parsed.netloc:
        raise HTTPException(status_code=400, detail="Invalid image URL")

    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=400, detail="Invalid image URL")

    try:
        resolved_ip = socket.gethostbyname(hostname)
        ip_obj = ipaddress.ip_address(resolved_ip)
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
        ):
            raise HTTPException(status_code=400, detail="Blocked host")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image host")

    scraper = _create_scraper(use_cloudflare=True)

    hostname_lc = (parsed.hostname or "").lower()
    site_referer: Optional[str]
    if re.search(r"\.wowpic\d+\.store$", hostname_lc):
        site_referer = "https://comix.to/"
    else:
        site_referer = f"{parsed.scheme}://{parsed.netloc}/" if parsed.scheme and parsed.netloc else None
    headers = {
        "User-Agent": COMICK_HEADERS.get("User-Agent", "Mozilla/5.0"),
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": COMICK_HEADERS.get("Accept-Language", "en-US,en;q=0.9"),
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }

    headers_with_referer = dict(headers)
    if site_referer:
        headers_with_referer["Referer"] = site_referer
        headers_with_referer["Origin"] = site_referer.rstrip("/")
        headers_with_referer["Sec-Fetch-Site"] = "same-site"
        headers_with_referer["Sec-Fetch-Mode"] = "no-cors"
        headers_with_referer["Sec-Fetch-Dest"] = "image"

    def _fallback_url(original: str) -> str:
        cleaned = original.replace("https://", "").replace("http://", "")
        return f"https://wsrv.nl/?url={quote(cleaned, safe='')}"

    def _fetch_bytes(fetch_url: str, *, request_headers: Optional[Dict[str, str]] = None) -> Tuple[int, str, bytes]:
        req_headers = request_headers or headers
        resp = scraper.get(fetch_url, headers=req_headers, timeout=25, stream=True, allow_redirects=True)
        status = int(getattr(resp, "status_code", 0) or 0)
        ctype = (resp.headers.get("Content-Type") or "").strip()
        body = resp.content
        try:
            resp.close()
        except Exception:
            pass
        return status, ctype, body

    try:
        status, content_type, data = _fetch_bytes(target, request_headers=headers)
        if status in (401, 403) and site_referer:
            status, content_type, data = _fetch_bytes(target, request_headers=headers_with_referer)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Image fetch failed: {exc}") from exc

    if status != 200 or content_type.lower().startswith("text/html"):
        try:
            fb_status, fb_ctype, fb_data = _fetch_bytes(_fallback_url(target))
        except Exception:
            fb_status, fb_ctype, fb_data = 0, "", b""

        if fb_status == 200 and fb_data and not fb_ctype.lower().startswith("text/html"):
            resp = Response(content=fb_data, media_type=fb_ctype or "application/octet-stream")
            resp.headers["Cache-Control"] = "public, max-age=86400"
            return resp

        redirect = RedirectResponse(url=target, status_code=307)
        redirect.headers["Cache-Control"] = "public, max-age=600"
        return redirect

    if len(data) > 40 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large")

    resp = Response(content=data, media_type=content_type or "application/octet-stream")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


class MangaDexChapterPages(BaseModel):
    chapter_id: str
    page_urls: List[str]


class ComickTitle(BaseModel):
    id: Optional[str] = None
    slug: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    status: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    followers: Optional[int] = None
    rating: Optional[float] = None
    last_chapter: Optional[str] = None
    country: Optional[str] = None
    year: Optional[int] = None


class ComickChapter(BaseModel):
    id: Optional[str] = None
    chapter: Optional[str] = None
    title: Optional[str] = None
    language: Optional[str] = None
    created_at: Optional[str] = None
    manga: Optional[ComickTitle] = None


def _comick_request(path: str, params: Optional[object] = None):
    query = params or None
    last_error: Optional[HTTPException] = None

    for base in COMICK_API_BASES:
        url = f"{base}{path}"
        try:
            attempts = 3
            for attempt in range(attempts):
                try:
                    resp = requests.get(url, params=query, headers=COMICK_HEADERS, timeout=20)
                    if resp.status_code in (502, 503, 504):
                        raise requests.HTTPError(f"Upstream {resp.status_code}", response=resp)
                    resp.raise_for_status()
                    try:
                        return resp.json()
                    except Exception:
                        return resp.text
                except (requests.Timeout, requests.ConnectionError) as exc:
                    if attempt >= attempts - 1:
                        raise exc
                    time.sleep(0.6 * (attempt + 1))
                except requests.HTTPError as exc:
                    status = getattr(getattr(exc, "response", None), "status_code", None)
                    if status in (502, 503, 504) and attempt < attempts - 1:
                        time.sleep(0.6 * (attempt + 1))
                        continue
                    raise
        except requests.HTTPError as exc:
            fallback, error = _handle_comick_http_error(url, query, exc)
            if fallback is not None:
                return fallback
            last_error = error
            continue
        except Exception as exc:
            last_error = HTTPException(status_code=502, detail=f"Comick API request failed: {exc}")
            continue

    if last_error:
        raise last_error
    raise HTTPException(status_code=502, detail="Comick API unreachable")


def _handle_comick_http_error(
    url: str, query: Optional[object], exc: requests.HTTPError
) -> Tuple[Optional[Any], HTTPException]:
    if exc.response is not None and exc.response.status_code in {503}:
        proxied = _proxy_fetch_json(url, query)
        if proxied is not None:
            return proxied, HTTPException(status_code=200, detail="Proxy success")
        return None, HTTPException(status_code=502, detail="Comick proxy failed: all proxies unreachable")
    status = exc.response.status_code if exc.response else 502
    detail = exc.response.text if exc.response else str(exc)
    return None, HTTPException(status_code=status, detail=f"Comick API error: {detail}")


def _proxy_fetch_json(url: str, query: Optional[object]) -> Optional[Any]:
    prepared = requests.Request("GET", url, params=query).prepare()
    proxied_url = prepared.url
    proxies = [
        ("https://api.allorigins.win/raw", "url"),
        ("https://thingproxy.freeboard.io/fetch", "url"),
        (f"https://r.jina.ai/{proxied_url}", None),
    ]
    for proxy_url, param_key in proxies:
        try:
            if param_key:
                proxy_resp = requests.get(proxy_url, params={param_key: proxied_url}, timeout=25)
            else:
                proxy_resp = requests.get(proxy_url, timeout=25)
            proxy_resp.raise_for_status()
            text = proxy_resp.text
            return _parse_proxy_payload(text)
        except Exception:
            continue
    return None


def _parse_proxy_payload(text: str) -> Any:
    stripped = text.strip()
    if not stripped:
        raise ValueError("Empty proxy response")

    def _try_parse(candidate: str) -> Optional[Any]:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            return None

    parsed = _try_parse(stripped)
    if parsed is not None:
        return parsed

    markdown_marker = "Markdown Content:"
    marker_idx = stripped.find(markdown_marker)
    if marker_idx != -1:
        candidate = stripped[marker_idx + len(markdown_marker):].strip()
        parsed = _try_parse(candidate)
        if parsed is not None:
            return parsed
    markers = ["\n[", "\n{", "[", "{"]
    for marker in markers:
        idx = stripped.find(marker)
        if idx != -1:
            candidate = stripped[idx:].lstrip()
            parsed = _try_parse(candidate)
            if parsed is not None:
                return parsed
    raise ValueError("Proxy response did not contain JSON payload")


def _comick_cover(md_covers: Optional[Any]) -> Optional[str]:
    candidates: List[Dict[str, Any]] = []
    if isinstance(md_covers, list):
        candidates = [entry for entry in md_covers if isinstance(entry, dict)]
    elif isinstance(md_covers, dict):
        candidates = [md_covers]
    for entry in candidates:
        key = entry.get("b2key") or entry.get("b2Key") or entry.get("key")
        if key:
            if key.startswith("http"):
                return key
            return f"https://meo.comick.pictures/{key}"
        url = entry.get("url")
        if url:
            return url
    return None


def _normalize_comick_comic(entry: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(entry, dict):
        return {}
    tags: List[str] = []
    genres = entry.get("md_comic_md_genres") or entry.get("genres")
    if isinstance(genres, list):
        for genre in genres:
            if isinstance(genre, dict):
                name = (
                    genre.get("md_genres", {}).get("name")
                    if isinstance(genre.get("md_genres"), dict)
                    else genre.get("name")
                )
                if name:
                    tags.append(str(name))
            elif isinstance(genre, str):
                tags.append(genre)

    cover_url = entry.get("cover_url") or _comick_cover(entry.get("md_covers"))
    if cover_url and not cover_url.startswith("http"):
        cover_url = f"https://meo.comick.pictures/{cover_url}"

    return {
        "id": entry.get("hid") or entry.get("id") or entry.get("slug"),
        "slug": entry.get("slug") or entry.get("hid"),
        "title": entry.get("title") or entry.get("name"),
        "description": entry.get("desc") or entry.get("description"),
        "cover_url": cover_url,
        "status": entry.get("status"),
        "last_chapter": entry.get("last_chapter") or entry.get("chapter") or entry.get("chapter_count"),
        "followers": entry.get("user_follow_count") or entry.get("follow_count"),
        "rating": entry.get("bayesian_rating") or entry.get("rating"),
        "tags": tags,
        "country": entry.get("country"),
        "year": entry.get("year"),
        "recommendations": entry.get("recommendations", []),
    }


def _normalize_comick_chapter(entry: Dict[str, Any]) -> Dict[str, Any]:
    manga = _normalize_comick_comic(entry.get("md_comics"))
    if manga and not manga.get("cover_url"):
        fallback_cover = entry.get("md_comics", {}).get("cover_url")
        if fallback_cover:
            manga["cover_url"] = fallback_cover
    return {
        "id": entry.get("hid") or entry.get("id"),
        "chapter": entry.get("chap") or entry.get("title"),
        "title": entry.get("title"),
        "language": entry.get("lang") or entry.get("language"),
        "created_at": entry.get("created_at") or entry.get("updated_at"),
        "manga": manga,
    }


@app.get("/api/comick/trending", response_model=List[ComickTitle])
async def comick_trending(limit: int = 12, category: Literal["rank", "trending", "7", "30"] = "rank"):
    params = {
        "type": "trending",
        "accept_mature_content": "false",
    }
    data = _comick_request("/top", params)
    order = [category, "rank", "trending", "7", "30"]
    seen_keys = []
    comics: List[Dict[str, Any]] = []
    for key in order:
        if key in seen_keys:
            continue
        seen_keys.append(key)
        entries = data.get(key)
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    comics.append(entry)
                if len(comics) >= limit:
                    break
        if len(comics) >= limit:
            break
    normalized = [_normalize_comick_comic(entry) for entry in comics]
    filtered = [ComickTitle(**item) for item in normalized if item]
    return filtered[: max(1, min(limit, len(filtered)))]


@app.get("/api/comick/latest", response_model=List[ComickChapter])
async def comick_latest(
    page: int = 1,
    lang: str = "en",
    order: Literal["hot", "new"] = "new",
    accept_erotic: bool = False,
    limit: int = 20,
):
    params = {
        "page": max(1, page),
        "order": order,
        "lang": lang,
        "accept_erotic_content": str(accept_erotic).lower(),
    }
    chapters = _comick_request("/chapter", params)
    if not isinstance(chapters, list):
        chapters = []
    normalized = [_normalize_comick_chapter(entry) for entry in chapters]
    items = [ComickChapter(**item) for item in normalized if item]
    limit_clamped = max(1, min(limit, 50))
    return items[:limit_clamped]


@app.get("/api/comick/search", response_model=List[ComickTitle])
async def comick_search(q: str, page: int = 1, limit: int = 18):
    params = {
        "q": q,
        "page": max(1, page),
        "limit": max(1, min(limit, 50)),
    }
    data = _comick_request("/v1.0/search", params)
    if not isinstance(data, list):
        data = []
    normalized = [_normalize_comick_comic(entry) for entry in data]
    return [ComickTitle(**item) for item in normalized if item]


@app.get("/api/comick/series")
async def comick_series(slug: str):
    if not slug:
        raise HTTPException(status_code=400, detail="Missing slug")
    data = _comick_request(f"/comic/{slug}", params={"with": "recommendations"})
    return data


@app.get("/api/comick/chapters")
async def comick_chapters(
    page: int = 1,
    order: str = "new",
    lang: str = "en",
    accept_erotic_content: bool = False,
):
    params = {
        "page": max(1, page),
        "order": order,
        "lang": lang,
        "accept_erotic_content": str(accept_erotic_content).lower(),
    }
    data = _comick_request("/chapter", params)
    if not isinstance(data, list):
        data = []
    return data


@app.get("/api/comick/series_chapters")
async def comick_series_chapters(first_chapter_hid: str):
    if not first_chapter_hid:
        raise HTTPException(status_code=400, detail="Missing first_chapter_hid")
    data = _comick_request(f"/chapter/{first_chapter_hid}")
    return data


@app.get("/api/comick/raw")
async def comick_raw(path: str, request: Request):
    forwarded_params: Dict[str, Any] = {}
    for key, value in request.query_params.multi_items():
        if key == "path":
            continue
        if key in forwarded_params:
            existing = forwarded_params[key]
            if isinstance(existing, list):
                existing.append(value)
            else:
                forwarded_params[key] = [existing, value]
        else:
            forwarded_params[key] = value

    normalized_path = (path or "").strip()
    if normalized_path.startswith("/comic/") or normalized_path.startswith("/chapter/"):
        if "accept_mature_content" not in forwarded_params:
            forwarded_params["accept_mature_content"] = "true"
        if "accept_erotic_content" not in forwarded_params:
            forwarded_params["accept_erotic_content"] = "true"

    try:
        data = _comick_request(path, forwarded_params or None)
        return data
    except HTTPException as exc:
        if exc.status_code != 404:
            raise

        if not normalized_path.startswith("/comic/"):
            raise

        requested_slug = normalized_path[len("/comic/"):].strip("/")
        if not requested_slug:
            raise

        query = requested_slug.replace("-", " ")
        try:
            search_params: Dict[str, Any] = {"q": query, "limit": 5}
            if "accept_mature_content" in forwarded_params:
                search_params["accept_mature_content"] = forwarded_params["accept_mature_content"]
            if "accept_erotic_content" in forwarded_params:
                search_params["accept_erotic_content"] = forwarded_params["accept_erotic_content"]
            results = _comick_request("/v1.0/search", params=search_params)
        except HTTPException:
            raise

        resolved_slug: Optional[str] = None
        if isinstance(results, list):
            requested_slug_lower = requested_slug.lower()
            exact_slug_match: Optional[Dict[str, Any]] = None
            for entry in results:
                if not isinstance(entry, dict):
                    continue
                entry_slug = entry.get("slug")
                if isinstance(entry_slug, str) and entry_slug.lower() == requested_slug_lower:
                    exact_slug_match = entry
                    break

            if exact_slug_match is not None:
                candidate = (
                    exact_slug_match.get("hid")
                    or exact_slug_match.get("slug")
                    or exact_slug_match.get("id")
                )
                if isinstance(candidate, str) and candidate.strip():
                    resolved_slug = candidate

            if resolved_slug is None:
                for entry in results:
                    if not isinstance(entry, dict):
                        continue
                    candidate = (entry.get("hid") or entry.get("slug") or entry.get("id"))
                    if not candidate or not isinstance(candidate, str):
                        continue
                    resolved_slug = candidate
                    break

        if not resolved_slug:
            raise
        resolved_normalized = resolved_slug.strip()
        if resolved_normalized.lower() == requested_slug.lower():
            raise

        data = _comick_request(f"/comic/{resolved_normalized}", forwarded_params or None)
        return data


@app.get("/api/comick/recommendations")
async def comick_recommendations(
    candidates: List[str] = Query([]),
    title: Optional[str] = None,
):
    slug = next((c for c in candidates if c and isinstance(c, str) and c.strip()), None)

    if not slug:
        if title:
            try:
                search_results = _comick_request("/v1.0/search", params={"q": title, "limit": 1})
                if search_results and isinstance(search_results, list) and search_results[0]:
                    slug = search_results[0].get("slug") or search_results[0].get("hid")
            except HTTPException:
                pass
        if not slug:
            return {"items": []}

    normalized_slug = slug.strip()
    now = time.time()
    cached = _RECOMMENDATION_CACHE.get(normalized_slug)
    if cached and now - cached[0] < _RECOMMENDATION_CACHE_TTL:
        return {"items": cached[1]}

    def _fetch_recommendations(params: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
        data = _comick_request(f"/comic/{normalized_slug}", params=params)
        if isinstance(data, dict):
            recs = data.get("recommendations", [])
            if isinstance(recs, list):
                return recs
        return []

    try:
        recs = _fetch_recommendations({"with": "recommendations"})
        if not recs:
            recs = _fetch_recommendations()
        if recs:
            _RECOMMENDATION_CACHE[normalized_slug] = (now, recs)
        else:
            _RECOMMENDATION_CACHE.pop(normalized_slug, None)
        return {"items": recs}
    except HTTPException as exc:
        if exc.status_code != 404:
            print(f"Error fetching recommendations for slug '{normalized_slug}': {exc}")
        _RECOMMENDATION_CACHE[normalized_slug] = (now, [])
        return {"items": []}
    except Exception as e:
        print(f"An unexpected error occurred for slug '{normalized_slug}': {e}")
        _RECOMMENDATION_CACHE[normalized_slug] = (now, [])
        return {"items": []}


@app.get("/api/source/asura/series")
async def asura_series(slug: str):
    if not slug:
        raise HTTPException(status_code=400, detail="Missing Asura slug or URL")

    normalized = slug.strip()

    # Asura has multiple domains / page implementations.
    # - https://asuracomic.net/series/<slug> (older Next.js)
    # - https://asurascans.com/comics/<slug> (new Astro)
    candidate_urls: List[str]
    if normalized.startswith("http"):
        candidate_urls = [normalized]
    else:
        s = normalized.strip("/")
        candidate_urls = [
            f"{ASURA_BASE}/series/{s}",
            f"https://asurascans.com/comics/{s}",
        ]

    scraper = _create_scraper(use_cloudflare=True)
    ASURA_HANDLER.configure_session(scraper, None)

    def _looks_generic_title(title: Optional[str]) -> bool:
        t = (title or "").strip().lower()
        if not t:
            return True
        return (
            "asura scans" in t
            and ("read manga" in t or "read manhwa" in t or "online" in t)
        )

    last_exc: Optional[Exception] = None
    context: Optional[SiteComicContext] = None
    chapters_raw: List[Dict[str, Any]] = []
    used_url: Optional[str] = None

    for idx, url in enumerate(candidate_urls):
        try:
            ctx = ASURA_HANDLER.fetch_comic_context(url, scraper, _simple_request)
            chaps = ASURA_HANDLER.get_chapters(ctx, scraper, "en", _simple_request)

            comic = ctx.comic or {}
            title_val = comic.get("name") or ctx.title
            cover_val = comic.get("cover") or comic.get("thumb")

            # If we got nothing meaningful, try the next candidate.
            if (not chaps) and (_looks_generic_title(title_val) or not cover_val):
                if idx < len(candidate_urls) - 1:
                    continue

            context = ctx
            chapters_raw = chaps or []
            used_url = url
            break
        except Exception as exc:
            last_exc = exc
            continue

    if context is None:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch Asura series: {last_exc}",
        ) from last_exc

    comic = context.comic or {}
    base_url = comic.get("_base_url") or ASURA_BASE
    slug_value = context.identifier or comic.get("slug") or slug
    # Prefer the actual URL we used when available.
    if used_url and used_url.startswith("http"):
        source_url = used_url
    else:
        source_url = f"{base_url.rstrip('/')}/series/{slug_value.strip('/')}"

    tags = []
    genres = comic.get("genres") or []
    if isinstance(genres, list):
        for entry in genres:
            if isinstance(entry, dict):
                name = entry.get("name")
            else:
                name = str(entry)
            if name:
                tags.append(name)

    title_info = {
        "id": comic.get("hid") or slug_value,
        "slug": slug_value,
        "title": comic.get("name") or context.title or slug_value,
        "description": comic.get("desc") or comic.get("description") or comic.get("summary"),
        "cover_url": comic.get("cover") or comic.get("thumb"),
        "status": comic.get("status"),
        "tags": tags,
        "source": "asura",
        "source_label": "Asura",
        "source_url": source_url,
        "language": "English",
    }

    chapters: List[Dict[str, Optional[str]]] = []
    for entry in chapters_raw:
        chap_id = entry.get("hid") or entry.get("url") or f"{slug_value}-{entry.get('chap')}"
        chapter_number = entry.get("chap")
        if chapter_number is not None:
            chapter_number = str(chapter_number)
        chapters.append(
            {
                "id": chap_id,
                "chapter": chapter_number,
                "title": entry.get("title"),
                "translated_language": "en",
                "scanlation_group": entry.get("group_name") or "Asura",
                "published_at": None,
                "url": entry.get("url"),
            }
        )

    chapters.sort(
        key=lambda ch: float(ch["chapter"]) if ch.get("chapter") and ch.get("chapter").replace(".", "", 1).isdigit() else 0,
        reverse=True,
    )

    return {
        "title": title_info,
        "chapters": chapters,
        "total_chapters": len(chapters),
    }


@app.get("/api/source/comix/series")
async def comix_source_series(slug: str):
    if not slug:
        raise HTTPException(status_code=400, detail="Missing Comix slug or URL")

    normalized = slug.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid Comix slug or URL")
    if not normalized.startswith("http"):
        normalized = normalized.strip("/")
        if "/" not in normalized:
            normalized = f"title/{normalized}"
        normalized = f"{COMIX_BASE.rstrip('/')}/{normalized}"

    # Use proxy-aware scraper for all comix.to requests
    scraper = _create_comix_scraper()
    COMIX_HANDLER.configure_session(scraper, None)

    def _extract_comix_hash_id(series_url: str) -> Optional[str]:
        try:
            path = urlparse(series_url).path
        except Exception:
            return None
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2 and parts[0] == "title":
            slug_part = parts[1]
            if "-" in slug_part:
                return slug_part.split("-", 1)[0]
            return slug_part
        return None

    def _proxy_comix_series(series_url: str) -> Optional[Dict[str, Any]]:
        hash_id = _extract_comix_hash_id(series_url)
        if not hash_id:
            return None

        manga_url = f"{COMIX_BASE}/api/v2/manga/{hash_id}"
        manga_payload = _proxy_fetch_json(manga_url, None)
        if not isinstance(manga_payload, dict) or manga_payload.get("status") != 200:
            return None
        comic = manga_payload.get("result") or {}
        if not isinstance(comic, dict):
            return None

        chapters: List[Dict[str, Any]] = []
        page = 1
        limit = 100
        while True:
            chapters_url = f"{COMIX_BASE}/api/v2/manga/{hash_id}/chapters"
            params: Dict[str, Any] = {"order[number]": "desc", "limit": limit, "page": page}
            chapters_payload = _proxy_fetch_json(chapters_url, params)
            if not isinstance(chapters_payload, dict) or chapters_payload.get("status") != 200:
                break
            result = chapters_payload.get("result") or {}
            if not isinstance(result, dict):
                break
            items = result.get("items") or []
            if not isinstance(items, list) or not items:
                break

            for item in items:
                if not isinstance(item, dict):
                    continue
                if item.get("language") != "en":
                    continue
                chap_num = item.get("number")
                chap_id = item.get("chapter_id")
                if chap_num is None or chap_id is None:
                    continue
                slug_value = comic.get("slug")
                if isinstance(slug_value, str) and slug_value:
                    slug_part = slug_value.strip("/")
                else:
                    slug_part = f"{hash_id}"
                if not slug_part.startswith(f"{hash_id}-"):
                    slug_part = f"{hash_id}-{slug_part}" if slug_part != hash_id else f"{hash_id}-{hash_id}"
                chap_url = f"{COMIX_BASE}/title/{slug_part}/{chap_id}-chapter-{chap_num}"

                group_info = item.get("scanlation_group")
                group_name: Optional[str] = None
                if isinstance(group_info, dict):
                    name_val = group_info.get("name")
                    if isinstance(name_val, str):
                        group_name = name_val

                chapters.append(
                    {
                        "url": chap_url,
                        "chap": str(chap_num),
                        "title": item.get("name") or f"Chapter {chap_num}",
                        "id": chap_id,
                        "group": group_name,
                        "up_count": item.get("votes", 0),
                        "language": item.get("language"),
                    }
                )

            if len(items) < limit:
                break
            page += 1

        return {"comic": comic, "chapters": chapters, "hash_id": hash_id}

    def _build_response(comic: Dict, chapters_raw: List, slug_val: str) -> Dict:
        cover_url = comic.get("cover") or comic.get("thumb")
        tags: List[str] = []
        for key in ("genres", "theme", "format"):
            values = comic.get(key) or []
            if isinstance(values, list):
                for val in values:
                    if not val:
                        continue
                    if isinstance(val, dict):
                        name = val.get("name") or val.get("title")
                        if name:
                            tags.append(str(name))
                    else:
                        tags.append(str(val))

        title_info = {
            "id": comic.get("hid") or slug_val,
            "slug": slug_val,
            "title": comic.get("title") or slug_val,
            "description": comic.get("desc") or comic.get("description") or comic.get("synopsis"),
            "cover_url": cover_url,
            "status": comic.get("status"),
            "tags": tags,
            "source": "comix",
            "source_label": "Comix",
            "source_url": normalized,
            "language": "English",
        }

        chapters: List[Dict[str, Optional[str]]] = []
        for entry in chapters_raw:
            if not isinstance(entry, dict):
                continue
            chap_id = (
                entry.get("id")
                or entry.get("chapter_id")
                or entry.get("url")
                or f"{slug_val}-{entry.get('chap')}"
            )
            chapter_number = entry.get("chap") or entry.get("number") or entry.get("chapter")
            if chapter_number is not None:
                chapter_number = str(chapter_number)
            group_name = entry.get("group") or entry.get("group_name")
            chapters.append(
                {
                    "id": chap_id,
                    "chapter": chapter_number,
                    "title": entry.get("title"),
                    "translated_language": (entry.get("language") or "en").lower(),
                    "scanlation_group": group_name or "Comix",
                    "published_at": None,
                    "url": entry.get("url"),
                }
            )

        chapters.sort(
            key=lambda ch: float(ch["chapter"]) if ch.get("chapter") and ch.get("chapter").replace(".", "", 1).isdigit() else 0,
            reverse=True,
        )

        return {
            "title": title_info,
            "chapters": chapters,
            "total_chapters": len(chapters),
            "slug": slug_val,
        }

    # Attempt 1: direct fetch through proxy
    try:
        context = COMIX_HANDLER.fetch_comic_context(normalized, scraper, _simple_request_with_retries)
        chapters_raw = COMIX_HANDLER.get_chapters(context, scraper, "en", _simple_request_with_retries)
        comic = context.comic or {}
        slug_value = context.identifier or comic.get("slug") or slug
        return _build_response(comic, chapters_raw, slug_value)

    except Exception as exc:
        detail = f"Failed to fetch Comix series: {exc}"
        should_try_proxy = False

        if isinstance(exc, requests.HTTPError):
            resp = getattr(exc, "response", None)
            status = getattr(resp, "status_code", None)
            url_attr = getattr(resp, "url", None)
            logger.warning("Comix series HTTPError upstream=%s url=%s", status, url_attr)
            detail = f"Failed to fetch Comix series: upstream={status} url={url_attr}"
            if status in (403, 429, 502, 503, 504):
                should_try_proxy = True
        elif isinstance(exc, (requests.Timeout, requests.ConnectionError)):
            logger.warning("Comix series network error: %s", exc)
            should_try_proxy = True
        else:
            logger.warning("Comix series fetch failed: %s", exc)

        # Attempt 2: public proxy fallback
        if should_try_proxy:
            try:
                proxied = _proxy_comix_series(normalized)
            except Exception:
                proxied = None
            if proxied is not None:
                comic = proxied.get("comic") or {}
                chapters_raw = proxied.get("chapters") or []
                slug_value = (
                    comic.get("hid")
                    or comic.get("hash_id")
                    or proxied.get("hash_id")
                    or slug
                )
                return _build_response(comic, chapters_raw, slug_value)

        raise HTTPException(status_code=502, detail=detail) from exc


@app.get("/api/comix/browse")
async def comix_browse(
    page: int = 1,
    limit: int = 28,
    genres_mode: str = "and",
    genre: Optional[str] = None,
    order: str = "views_30d",
):
    sort_key = (order or "views_30d").strip() or "views_30d"
    params: Dict[str, Any] = {
        "genres_mode": genres_mode,
        "limit": max(1, min(limit, 50)),
        "page": max(1, page),
        f"order[{sort_key}]": "desc",
    }

    normalized_genre = (genre or "").strip()
    if normalized_genre and normalized_genre.lower() != "random":
        params["genres[]"] = normalized_genre

    scraper = _create_comix_scraper()
    COMIX_HANDLER.configure_session(scraper, None)

    try:
        data = _simple_request_with_retries((f"{COMIX_BASE}/api/v2/manga", params), scraper).json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to browse Comix: {exc}") from exc

    return data


@app.get("/api/comix/manga/{hid}")
async def comix_manga(hid: str):
    if not hid:
        raise HTTPException(status_code=400, detail="Missing Comix manga hid")

    scraper = _create_comix_scraper()
    COMIX_HANDLER.configure_session(scraper, None)

    try:
        data = _simple_request_with_retries(f"{COMIX_BASE}/api/v2/manga/{hid}", scraper).json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch Comix manga: {exc}") from exc

    return data


@app.get("/api/source/mangataro/series")
async def mangataro_series(request: Request, slug: str):
    if not slug:
        raise HTTPException(status_code=400, detail="Missing Mangataro slug or URL")

    normalized = slug.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid Mangataro slug or URL")
    if not normalized.startswith("http"):
        normalized = normalized.strip("/")
        if "/" not in normalized:
            normalized = f"manga/{normalized}"
        normalized = f"{MANGATARO_BASE.rstrip('/')}/{normalized}"

    scraper = _create_scraper(use_cloudflare=True)
    settings = _load_user_settings()
    cookie_string = settings.get("cookies", {}).get("mangataro", "")
    _apply_mangataro_cookies(scraper, cookie_string)
    MANGATARO_HANDLER.configure_session(scraper, None)

    try:
        context = MANGATARO_HANDLER.fetch_comic_context(normalized, scraper, _simple_request)
        metadata = MANGATARO_HANDLER.extract_additional_metadata(context)
        chapters_raw = MANGATARO_HANDLER.get_chapters(context, scraper, "en", _simple_request)

        print("--- MANGATARO RAW CHAPTERS ---")
        for i, ch in enumerate(chapters_raw[:5]):
            print(f"  Chapter {i+1}: {ch}")
        print("----------------------------")

    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch Mangataro series: {exc}") from exc

    comic = context.comic or {}
    slug_value = context.identifier or comic.get("slug") or slug
    cover_url = comic.get("cover_url") or comic.get("cover")
    if not cover_url and context.soup is not None:
        og_image = context.soup.find("meta", attrs={"property": "og:image"})
        if og_image and og_image.get("content"):
            cover_url = og_image["content"].strip() or cover_url
    tags: List[str] = []
    for key in ("genres", "theme"):
        values = metadata.get(key) if metadata else None
        if isinstance(values, list):
            tags.extend(str(val) for val in values if val)

    title_info = {
        "id": comic.get("hid") or slug_value,
        "slug": slug_value,
        "title": comic.get("title") or context.title or slug_value,
        "description": comic.get("desc"),
        "cover_url": cover_url,
        "status": comic.get("status"),
        "tags": tags,
        "source": "mangataro",
        "source_label": "Mangataro",
        "source_url": normalized,
        "language": "English",
    }

    chapters: List[Dict[str, Optional[str]]] = []
    for entry in chapters_raw:
        if not isinstance(entry, dict):
            continue
        chap_id = entry.get("hid") or entry.get("url") or f"{slug_value}-{entry.get('chap')}"
        chapter_number = entry.get("chap")
        if chapter_number is not None:
            chapter_number = str(chapter_number)
        chapters.append(
            {
                "id": chap_id,
                "chapter": chapter_number,
                "title": entry.get("title"),
                "translated_language": (entry.get("lang") or "en").lower(),
                "scanlation_group": entry.get("group_name") or "Mangataro",
                "published_at": None,
                "url": entry.get("url"),
            }
        )

    chapters.sort(
        key=lambda ch: float(ch["chapter"]) if ch.get("chapter") and ch.get("chapter").replace(".", "", 1).isdigit() else 0,
        reverse=True,
    )

    return {
        "title": title_info,
        "chapters": chapters,
        "total_chapters": len(chapters),
        "slug": slug_value,
    }


@app.get("/api/source/asura/chapter-pages", response_model=MangaDexChapterPages)
async def asura_chapter_pages(url: str):
    if not url:
        raise HTTPException(status_code=400, detail="Missing Asura chapter URL")

    scraper = requests.Session()
    ASURA_HANDLER.configure_session(scraper, None)

    try:
        page_urls = ASURA_HANDLER.get_chapter_images({"url": url}, scraper, _simple_request)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch Asura chapter: {exc}") from exc

    if not page_urls:
        raise HTTPException(status_code=404, detail="Asura chapter contains no pages")

    return MangaDexChapterPages(chapter_id=url, page_urls=page_urls)


@app.get("/api/source/comix/chapter-pages", response_model=MangaDexChapterPages)
async def comix_chapter_pages(url: str):
    if not url:
        raise HTTPException(status_code=400, detail="Missing Comix chapter URL")

    scraper = _create_comix_scraper()
    COMIX_HANDLER.configure_session(scraper, None)

    page_urls: List[str] = []

    chapter_id: Optional[int] = None
    match = re.search(r"/(\d+)-chapter", url)
    if match:
        try:
            chapter_id = int(match.group(1))
        except ValueError:
            chapter_id = None

    if chapter_id is not None:
        api_url = f"https://comix.to/api/v2/chapters/{chapter_id}"
        try:
            resp = _simple_request_with_retries(api_url, scraper)
            try:
                data = resp.json()
            except ValueError:
                data = None
            if isinstance(data, dict) and data.get("status") == 200:
                result = data.get("result") or {}
                imgs = result.get("images") or []
                if isinstance(imgs, list):
                    for entry in imgs:
                        img_url: Optional[str] = None
                        if isinstance(entry, dict):
                            value = entry.get("url") or entry.get("src")
                            if isinstance(value, str):
                                img_url = value
                        elif isinstance(entry, str):
                            img_url = entry
                        if img_url and isinstance(img_url, str):
                            img_url = img_url.strip()
                            if img_url:
                                page_urls.append(img_url)
        except Exception:
            page_urls = []

    if not page_urls:
        try:
            page_urls = COMIX_HANDLER.get_chapter_images({"url": url}, scraper, _simple_request_with_retries)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Failed to fetch Comix chapter: {exc}") from exc

    if not page_urls:
        raise HTTPException(status_code=404, detail="Comix chapter contains no pages")

    return MangaDexChapterPages(chapter_id=url, page_urls=page_urls)


@app.get("/api/source/mangataro/chapter-pages", response_model=MangaDexChapterPages)
async def mangataro_chapter_pages(request: Request, url: str):
    if not url:
        raise HTTPException(status_code=400, detail="Missing Mangataro chapter URL")

    scraper = _create_scraper(use_cloudflare=True)
    settings = _load_user_settings()
    cookie_string = settings.get("cookies", {}).get("mangataro", "")
    print(f"--- READER IS USING MANGATARO COOKIE: {cookie_string[:50]}... ---")
    _apply_mangataro_cookies(scraper, cookie_string)
    MANGATARO_HANDLER.configure_session(scraper, None)

    try:
        entries = MANGATARO_HANDLER.get_chapter_images({"url": url}, scraper, _simple_request)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch Mangataro chapter: {exc}") from exc

    page_urls = [entry for entry in entries if isinstance(entry, str) and entry]
    if not page_urls:
        raise HTTPException(status_code=404, detail="Mangataro chapter contains no images")

    return MangaDexChapterPages(chapter_id=url, page_urls=page_urls)


@app.get("/api/test-mangataro")
async def test_mangataro_endpoint():
    test_chapter_url = "https://mangataro.org/read/solo-leveling/ch200-9355"
    print(f"--- RUNNING MANGATARO TEST FOR: {test_chapter_url} ---")
    scraper = _create_scraper(use_cloudflare=True)
    MANGATARO_HANDLER.configure_session(scraper, None)

    try:
        entries = MANGATARO_HANDLER.get_chapter_images({"url": test_chapter_url}, scraper, _simple_request)
        print("--- TEST RESULT: SUCCESS ---")
        print(f"Found {len(entries)} entries.")
        for i, entry in enumerate(entries):
            if isinstance(entry, str):
                print(f"  Image {i+1}: {entry}")
            else:
                print(f"  Text block {i+1}: {entry.get('paragraphs', [])[:1]}...")
        return {"status": "success", "entries": entries}
    except Exception as exc:
        print(f"--- TEST RESULT: FAILED ---")
        print(f"Error: {exc}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Test failed: {exc}")


@app.get("/api/mangadex/chapter/{chapter_id}/pages", response_model=MangaDexChapterPages)
async def mangadex_chapter_pages(chapter_id: str):
    data = _mangadex_request(f"/at-home/server/{chapter_id}")
    if data.get("result") == "error":
        errors = data.get("errors") or []
        err = errors[0] if errors else {}
        status = err.get("status") or 502
        detail = err.get("detail") or "MangaDex chapter unavailable"
        raise HTTPException(status_code=int(status), detail=detail)
    base_url = data.get("baseUrl")
    chapter = data.get("chapter") or {}
    file_hash = chapter.get("hash")
    images = chapter.get("data") or []
    path_segment = "data"
    if not images:
        images = chapter.get("dataSaver") or []
        path_segment = "data-saver"
    if not base_url or not file_hash or not images:
        raise HTTPException(status_code=502, detail="MangaDex At-Home did not return pages")
    urls = [f"{base_url}/{path_segment}/{file_hash}/{fname}" for fname in images]
    return MangaDexChapterPages(chapter_id=chapter_id, page_urls=urls)
