import argparse
import html as html_lib
import re
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterable, Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

try:
    from playwright.sync_api import sync_playwright  # type: ignore
except Exception:  # pragma: no cover
    sync_playwright = None


_BASE_URL = "https://asurascans.com"
# Asura browse embeds series URLs like: "public_url":"/comics/nano-machine-f6174291"
# Slugs appear to be lowercase and end with an 8-hex suffix.
_COMICS_SLUG_RE = re.compile(r"/comics/([a-z0-9-]+)")
_SERIES_SLUG_RE = re.compile(r"/series/([a-z0-9-]+)")
_EXPECTED_SUFFIX_RE = re.compile(r"-[0-9a-f]{8}$")
_PUBLIC_URL_RE = re.compile(
    r"public_url\"\s*:\s*(?:\"/(?:comics|series)/([a-z0-9-]+)\"|\[0,\"/(?:comics|series)/([a-z0-9-]+)\"\])"
)
_COVER_URL_RE = re.compile(
    r"(?:cover_url|cover)\"\s*:\s*(?:\"(https?://[^\"]+)\"|\[0,\"(https?://[^\"]+)\"\])"
)
_COVER_ASSET_URL_RE = re.compile(r"(https?://[^\"\s]+/covers/[^\"\s]+)")


def _pick_cover_from_img(img: BeautifulSoup) -> str:
    if img is None:
        return ""

    for attr in ("src", "data-src"):
        v = (img.get(attr) or "").strip()
        if v and _looks_like_cover_url(v) and "/covers/" in v:
            return v

    for attr in ("srcset", "data-srcset"):
        v = (img.get(attr) or "").strip()
        if not v:
            continue
        # srcset format: url1 1x, url2 2x ...
        first = v.split(",", 1)[0].strip()
        url = first.split(" ", 1)[0].strip()
        if url and _looks_like_cover_url(url) and "/covers/" in url:
            return url

    return ""


def _is_valid_series_slug(slug: str) -> bool:
    s = (slug or "").strip().lower()
    if not s:
        return False
    # Keep this strict to avoid grabbing random embedded strings.
    if not _EXPECTED_SUFFIX_RE.search(s):
        return False
    if not re.fullmatch(r"[a-z0-9-]+", s):
        return False
    return True


def _looks_like_cover_url(url: str) -> bool:
    u = (url or "").strip()
    if not u:
        return False
    if not (u.startswith("http://") or u.startswith("https://")):
        return False
    return True


def _build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": f"{_BASE_URL}/",
            "Origin": _BASE_URL,
        }
    )
    return s


def _extract_og_image(html: str) -> str:
    soup = BeautifulSoup(html or "", "html.parser")
    meta = soup.select_one("meta[property='og:image'][content]")
    if meta is not None:
        v = (meta.get("content") or "").strip()
        if _looks_like_cover_url(v):
            return v
    meta = soup.select_one("meta[name='twitter:image'][content]")
    if meta is not None:
        v = (meta.get("content") or "").strip()
        if _looks_like_cover_url(v):
            return v
    return ""


def _fetch_cover_for_slug(session: requests.Session, slug: str, timeout: float) -> str:
    url = f"{_BASE_URL}/comics/{slug}"
    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    cover = _extract_og_image(r.text)
    if cover and "/covers/" in cover:
        return cover
    # Some titles may not use /covers/; still accept og:image if present.
    return cover


def resolve_covers(
    slugs: list[str],
    timeout: float,
    workers: int,
    per_request_delay: float,
) -> dict[str, str]:
    session = _build_session()
    out: dict[str, str] = {}

    def _job(s: str) -> tuple[str, str]:
        if per_request_delay:
            time.sleep(per_request_delay)
        try:
            return s, _fetch_cover_for_slug(session, s, timeout=timeout)
        except Exception:
            return s, ""

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futs = [ex.submit(_job, s) for s in slugs]
        for fut in as_completed(futs):
            slug, cover = fut.result()
            if cover and _looks_like_cover_url(cover):
                out[slug] = cover

    return out


def _extract_slug_cover_pairs_from_html(html: str) -> dict[str, str]:
    # Asura browse pages are client-rendered, but the initial HTML often still embeds
    # the series listing as JSON with fields like "public_url":"/comics/<slug>".
    # Also note the payload is HTML-escaped (e.g. &quot;), so unescape first.
    raw = html_lib.unescape(html or "")

    soup = BeautifulSoup(html, "html.parser")
    out: dict[str, str] = {}

    # DOM-based extraction: for each series link, try to locate a nearby image URL.
    for a in soup.select("a[href]"):
        href = a.get("href") or ""
        m = _COMICS_SLUG_RE.search(href) or _SERIES_SLUG_RE.search(href)
        if not m:
            continue
        slug = (m.group(1) or "").strip()
        if not _is_valid_series_slug(slug):
            continue

        # Only trust images *inside* the anchor to avoid grabbing a neighbor card's cover.
        img = a.select_one("img")
        cover = _pick_cover_from_img(img)

        if slug not in out:
            out[slug] = cover
        else:
            if not out[slug] and cover:
                out[slug] = cover

    # Best signal: embedded object snippets that contain both public_url and cover.
    # Pairing strategy: for each public_url match, only search for cover inside the slice
    # up to the next public_url. This prevents accidentally stealing the next card's cover.
    pub_matches = list(_PUBLIC_URL_RE.finditer(raw))
    for idx, m in enumerate(pub_matches):
        slug = (m.group(1) or m.group(2) or "").strip()
        if not _is_valid_series_slug(slug):
            continue

        end = pub_matches[idx + 1].start() if idx + 1 < len(pub_matches) else min(len(raw), m.start() + 8000)
        window = raw[m.start() : end]

        cm = _COVER_URL_RE.search(window)
        cover = ""
        if cm:
            cover = (cm.group(1) or cm.group(2) or "").strip()
        if not cover:
            am = _COVER_ASSET_URL_RE.search(window)
            if am:
                cover = (am.group(1) or "").strip()

        if cover and (not _looks_like_cover_url(cover) or "/covers/" not in cover):
            cover = ""

        if slug not in out:
            out[slug] = cover
        else:
            if not out[slug] and cover:
                out[slug] = cover

    # Fallback: scan entire HTML (after unescape) for /comics/<slug> references.
    for rx in (_COMICS_SLUG_RE, _SERIES_SLUG_RE):
        for m in rx.finditer(raw):
            slug = (m.group(1) or "").strip()
            if not _is_valid_series_slug(slug):
                continue
            out.setdefault(slug, "")

    return out


def _pairs_to_lines(pairs: Iterable[tuple[str, str]], order: str) -> list[str]:
    lines: list[str] = []
    for slug, cover in pairs:
        if order == "cover_slug":
            lines.append(f"{cover}|{slug}")
        else:
            lines.append(f"{slug}|{cover}")
    return lines


def _playwright_extract_slugs(url: str, wait_ms: int, growth_timeout_ms: int) -> list[str]:
    if sync_playwright is None:
        raise RuntimeError("playwright is not installed")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.set_default_timeout(max(5_000, growth_timeout_ms))
        page.set_default_navigation_timeout(30_000)

        page.goto(url, wait_until="domcontentloaded")
        # Wait for the client-side browse list to render.
        page.wait_for_function(
            "() => document.querySelectorAll(\"a[href*='/comics/'], a[href*='/series/']\").length > 0",
            timeout=growth_timeout_ms,
        )

        if wait_ms:
            page.wait_for_timeout(wait_ms)

        hrefs = page.eval_on_selector_all(
            "a[href*='/comics/'], a[href*='/series/']",
            "els => els.map(e => e.getAttribute('href')).filter(Boolean)",
        )

        browser.close()

    out: list[str] = []
    seen: set[str] = set()
    for href in hrefs:
        m = _COMICS_SLUG_RE.search(href) or _SERIES_SLUG_RE.search(href)
        if not m:
            continue
        slug = (m.group(1) or "").strip()
        if slug and slug not in seen:
            seen.add(slug)
            out.append(slug)
    return out


def _default_output_path() -> Path:
    return Path("list") / "asurascans_slugs.txt"


def _load_existing_pairs(path: Path) -> tuple[list[str], dict[str, str]]:
    if not path.exists():
        return [], {}

    order: list[str] = []
    mapping: dict[str, str] = {}
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = (raw or "").strip()
            if not line:
                continue

            slug = ""
            cover = ""

            if "|" in line:
                a, b = line.split("|", 1)
                a = a.strip()
                b = b.strip()
                # Accept either slug|cover or cover|slug from previous runs.
                if _is_valid_series_slug(a):
                    slug, cover = a, b
                elif _is_valid_series_slug(b):
                    slug, cover = b, a
            else:
                if _is_valid_series_slug(line):
                    slug = line

            if not slug:
                continue
            if slug not in mapping:
                order.append(slug)
            if cover and _looks_like_cover_url(cover):
                mapping[slug] = cover
            else:
                mapping.setdefault(slug, "")

    return order, mapping


def _write_lines(path: Path, lines: Iterable[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for line in lines:
            f.write(f"{line}\n")


def scrape_slugs(
    start_page: int,
    end_page: int,
    delay: float,
    timeout: float,
    use_playwright: bool,
    wait_ms: int,
    growth_timeout_ms: int,
) -> list[str]:
    session = _build_session()

    ordered: list[str] = []
    seen: set[str] = set()

    for page in range(start_page, end_page + 1):
        url = f"{_BASE_URL}/browse?page={page}"
        print(f"[asurascans] page {page}: {url}")

        slugs: list[str] = []
        if use_playwright and sync_playwright is not None:
            slugs = _playwright_extract_slugs(url, wait_ms=wait_ms, growth_timeout_ms=growth_timeout_ms)
        else:
            r = session.get(url, timeout=timeout)
            r.raise_for_status()
            pairs = _extract_slug_cover_pairs_from_html(r.text)
            slugs = list(pairs.keys())

        for slug in slugs:
            if slug in seen:
                continue
            seen.add(slug)
            ordered.append(slug)

        if delay:
            time.sleep(delay)

    return ordered


def scrape_slug_cover_pairs(start_page: int, end_page: int, delay: float, timeout: float) -> dict[str, str]:
    session = _build_session()
    out: dict[str, str] = {}

    for page in range(start_page, end_page + 1):
        url = f"{_BASE_URL}/browse?page={page}"
        print(f"[asurascans] page {page}: {url}")
        r = session.get(url, timeout=timeout)
        r.raise_for_status()
        pairs = _extract_slug_cover_pairs_from_html(r.text)

        for slug, cover in pairs.items():
            if slug not in out:
                out[slug] = cover
            else:
                if not out[slug] and cover:
                    out[slug] = cover

        if delay:
            time.sleep(delay)

    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-page", type=int, default=1)
    ap.add_argument("--end-page", type=int, default=19)
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--output", type=Path, default=_default_output_path())
    ap.add_argument("--use-playwright", action="store_true")
    ap.add_argument("--wait-ms", type=int, default=200)
    ap.add_argument("--growth-timeout-ms", type=int, default=12_000)
    ap.add_argument("--order", choices=["slug_cover", "cover_slug"], default="slug_cover")
    ap.add_argument("--resolve-covers", action="store_true")
    ap.add_argument("--resolve-workers", type=int, default=8)
    ap.add_argument("--resolve-delay", type=float, default=0.0)
    args = ap.parse_args()

    out: Path = args.output
    if not out.is_absolute():
        out = Path.cwd() / out

    parsed = urlparse(_BASE_URL)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit("Invalid base URL")

    existing_order, existing_map = _load_existing_pairs(out)

    if args.use_playwright:
        # Playwright path currently extracts slugs only; covers will be empty.
        scraped_slugs = scrape_slugs(
            args.start_page,
            args.end_page,
            args.delay,
            args.timeout,
            use_playwright=args.use_playwright,
            wait_ms=args.wait_ms,
            growth_timeout_ms=args.growth_timeout_ms,
        )
        scraped_map: dict[str, str] = {s: "" for s in scraped_slugs}
    else:
        scraped_map = scrape_slug_cover_pairs(args.start_page, args.end_page, args.delay, args.timeout)

    new_slugs = 0
    updated_covers = 0
    for slug, cover in scraped_map.items():
        if slug not in existing_map:
            existing_order.append(slug)
            existing_map[slug] = cover
            new_slugs += 1
        else:
            if not existing_map.get(slug) and cover:
                existing_map[slug] = cover
                updated_covers += 1

    lines = _pairs_to_lines(((s, existing_map.get(s, "")) for s in existing_order), order=args.order)
    _write_lines(out, lines)

    if args.resolve_covers:
        print(f"[asurascans] resolving covers via /comics/<slug> pages...")
        resolved = resolve_covers(
            existing_order,
            timeout=args.timeout,
            workers=args.resolve_workers,
            per_request_delay=args.resolve_delay,
        )
        resolved_count = 0
        for slug, cover in resolved.items():
            if cover and existing_map.get(slug) != cover:
                existing_map[slug] = cover
                resolved_count += 1

        lines = _pairs_to_lines(((s, existing_map.get(s, "")) for s in existing_order), order=args.order)
        _write_lines(out, lines)
        print(f"[asurascans] covers updated from series pages: {resolved_count}")

    print(f"[asurascans] new slugs this run: {new_slugs}")
    print(f"[asurascans] covers filled this run: {updated_covers}")
    print(f"[asurascans] total slugs in file: {len(existing_order)}")
    print(f"[asurascans] wrote {out}")


if __name__ == "__main__":
    main()
