import argparse
import re
import time
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

try:
    import cloudscraper  # type: ignore
except Exception:  # pragma: no cover
    cloudscraper = None

try:
    from playwright.sync_api import sync_playwright  # type: ignore
except Exception:  # pragma: no cover
    sync_playwright = None


_MANGA_SLUG_RE = re.compile(r"/manga/([^/?#]+)")
_REST_URL_RE = re.compile(r'"rest_url"\s*:\s*"(https?:\\/\\/[^\"]+)"')
_NONCE_RE = re.compile(r'"nonce"\s*:\s*"([^\"]+)"')


def _build_session() -> requests.Session:
    if cloudscraper is not None:
        s = cloudscraper.create_scraper()
    else:
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
            "Referer": "https://mangataro.org/",
            "Origin": "https://mangataro.org",
        }
    )
    return s


def _apply_cookie_string(session: requests.Session, cookie_string: Optional[str]) -> None:
    if not cookie_string:
        return
    for part in cookie_string.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        name = name.strip()
        value = value.strip()
        if not name:
            continue
        session.cookies.set(name, value, domain="mangataro.org", path="/")
        session.cookies.set(name, value, domain=".mangataro.org", path="/")


def _dbg(enabled: bool, msg: str) -> None:
    if enabled:
        print(msg)


def _extract_manga_slugs(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    slugs: list[str] = []
    seen: set[str] = set()

    for a in soup.select("a[href]"):
        href = a.get("href") or ""
        m = _MANGA_SLUG_RE.search(href)
        if not m:
            continue
        slug = m.group(1).strip()
        if not slug or slug in seen:
            continue
        seen.add(slug)
        slugs.append(slug)

    return slugs


def _extract_slugs_from_any_payload(payload: object) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()

    def visit(obj: object) -> None:
        if obj is None:
            return
        if isinstance(obj, str):
            for m in _MANGA_SLUG_RE.finditer(obj):
                slug = (m.group(1) or "").strip()
                if slug and slug not in seen:
                    seen.add(slug)
                    out.append(slug)
            return
        if isinstance(obj, dict):
            for v in obj.values():
                visit(v)
            return
        if isinstance(obj, (list, tuple)):
            for v in obj:
                visit(v)
            return

    visit(payload)
    return out


def _discover_infinite_scroll_api(html: str) -> tuple[Optional[str], Optional[str]]:
    m_url = _REST_URL_RE.search(html)
    m_nonce = _NONCE_RE.search(html)
    rest_url = None
    nonce = None
    if m_url:
        rest_url = m_url.group(1).replace("\\/", "/")
    if m_nonce:
        nonce = m_nonce.group(1)
    return rest_url, nonce


def _playwright_scroll_scrape(
    start_url: str,
    max_scrolls: int,
    debug: bool,
    scroll_wait_ms: int = 400,
    growth_timeout_ms: int = 5000,
) -> list[str]:
    if sync_playwright is None:
        raise RuntimeError("playwright is not installed")

    slugs: list[str] = []
    seen: set[str] = set()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        page.set_default_timeout(15_000)
        page.set_default_navigation_timeout(30_000)

        page.goto(start_url, wait_until="domcontentloaded")
        page.wait_for_timeout(min(1200, scroll_wait_ms + 800))

        last_slug_count = 0
        no_growth_rounds = 0

        # Track how many hrefs we've already processed so we don't rescan the full DOM every time.
        processed_hrefs = 0

        for i in range(max_scrolls):
            if debug:
                _dbg(debug, f"[mangataro] playwright scan {i+1}/{max_scrolls} ...")

            # Only pull the newly added hrefs since the last scroll.
            hrefs = page.eval_on_selector_all(
                "a[href*='/manga/']",
                "(els, start) => els.slice(start).map(e => e.getAttribute('href')).filter(Boolean)",
                processed_hrefs,
            )
            # Update processed_hrefs to current total count.
            total_hrefs = page.eval_on_selector_all(
                "a[href*='/manga/']",
                "els => els.length",
            )
            processed_hrefs = int(total_hrefs) if isinstance(total_hrefs, (int, float)) else processed_hrefs

            for href in hrefs:
                m = _MANGA_SLUG_RE.search(href)
                if not m:
                    continue
                slug = (m.group(1) or "").strip()
                if slug and slug not in seen:
                    seen.add(slug)
                    slugs.append(slug)

            _dbg(debug, f"[mangataro] playwright slugs={len(slugs)} new_hrefs={len(hrefs)} total_hrefs={processed_hrefs}")

            if len(slugs) <= last_slug_count:
                no_growth_rounds += 1
            else:
                no_growth_rounds = 0
                last_slug_count = len(slugs)

            # Scroll to trigger infinite loading
            prev_href_count = processed_hrefs
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")

            # Wait up to a bit for the DOM to grow. If it doesn't, we likely reached the end.
            try:
                page.wait_for_function(
                    "prev => document.querySelectorAll(\"a[href*='/manga/']\").length > prev",
                    arg=prev_href_count,
                    timeout=growth_timeout_ms,
                )
            except Exception:
                # Give it one last small wait; then bail if still no growth.
                page.wait_for_timeout(scroll_wait_ms)

            if no_growth_rounds >= 3:
                break

        browser.close()

    return slugs


def _fetch_api_page(session: requests.Session, rest_url: str, nonce: Optional[str], page: int, timeout: float) -> object:
    headers = {}
    if nonce:
        headers["X-WP-Nonce"] = nonce
    headers["Referer"] = "https://mangataro.org/browse"
    headers["Accept"] = "application/json, text/plain, */*"

    # Mangataro seems to use a WP REST endpoint behind infinite scroll.
    # Try a few common shapes to keep this resilient.
    # Different MangaPeak/Madara-like themes use different parameter names.
    # We try multiple common variants.
    attempts = [
        ("get", {"page": page}),
        ("get", {"paged": page}),
        ("get", {"page": page, "per_page": 24}),
        ("get", {"paged": page, "per_page": 24}),
        ("get", {"offset": (page - 1) * 24, "limit": 24}),
        ("post_form", {"page": page}),
        ("post_form", {"paged": page}),
        ("post_form", {"page": page, "per_page": 24}),
        ("post_form", {"offset": (page - 1) * 24, "limit": 24}),
        ("post_json", {"page": page}),
        ("post_json", {"paged": page}),
        ("post_json", {"page": page, "per_page": 24}),
        ("post_json", {"offset": (page - 1) * 24, "limit": 24}),
    ]

    last_exc: Optional[Exception] = None
    for kind, data in attempts:
        try:
            if kind == "get":
                r = session.get(rest_url, params=data, headers=headers, timeout=timeout)
            elif kind == "post_form":
                r = session.post(rest_url, data=data, headers=headers, timeout=timeout)
            else:
                r = session.post(rest_url, json=data, headers=headers, timeout=timeout)

            # Some setups return 403 but still include a usable payload.
            if r.status_code >= 400 and (not r.text or len(r.text) < 20):
                r.raise_for_status()

            try:
                return r.json()
            except Exception:
                return r.text
        except Exception as exc:
            last_exc = exc
            continue

    if last_exc:
        raise last_exc
    raise RuntimeError("Unable to fetch API page")


def _find_next_page_url(current_url: str, html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")

    link = soup.select_one("a[rel='next'][href]")
    if link and link.get("href"):
        return urljoin(current_url, link.get("href"))

    for a in soup.select("a[href]"):
        text = (a.get_text(" ", strip=True) or "").strip().lower()
        if text in {"next", "next page", "›", ">"}:
            href = a.get("href")
            if href:
                return urljoin(current_url, href)

    return None


def scrape_slugs(
    start_url: str,
    max_pages: int,
    delay: float,
    timeout: float,
    debug: bool = False,
    cookie_string: Optional[str] = None,
    use_playwright: bool = False,
    max_scrolls: int = 200,
    scroll_wait_ms: int = 400,
    growth_timeout_ms: int = 5000,
) -> dict[str, str]:
    """Returns dict of {slug: cover_url}"""
    session = _build_session()
    _apply_cookie_string(session, cookie_string)

    result: dict[str, str] = {}
    seen: set[str] = set()

    # Use the POST API endpoint directly - much faster than playwright
    api_url = "https://mangataro.org/wp-json/manga/v1/load"
    session.headers.update({
        "Accept": "application/json",
        "Content-Type": "application/json",
    })

    _dbg(debug, f"[mangataro] using POST API: {api_url}")

    for page in range(1, max_pages + 1):
        try:
            r = session.post(api_url, json={"page": page}, timeout=timeout)
        except Exception as e:
            _dbg(debug, f"[mangataro] page {page} request error: {e}")
            break

        if r.status_code != 200:
            _dbg(debug, f"[mangataro] page {page} status {r.status_code}")
            break

        try:
            data = r.json()
        except Exception:
            _dbg(debug, f"[mangataro] page {page} JSON parse error")
            break

        if not isinstance(data, list):
            _dbg(debug, f"[mangataro] page {page} not a list: {type(data)}")
            break

        if not data:
            _dbg(debug, f"[mangataro] page {page} empty response, done")
            break

        found = 0
        for item in data:
            url = item.get("url", "")
            m = _MANGA_SLUG_RE.search(url)
            if m:
                slug = m.group(1).strip()
                if slug and slug not in seen:
                    seen.add(slug)
                    cover = item.get("cover", "").strip()
                    result[slug] = cover
                    found += 1

        _dbg(debug, f"[mangataro] page {page}: +{found} slugs (total: {len(result)})")

        if found == 0:
            break

        if delay:
            time.sleep(delay)

    if result:
        return result

    # Fallback to playwright if API fails completely
    if use_playwright:
        slugs = _playwright_scroll_scrape(
            start_url,
            max_scrolls=max_scrolls,
            debug=debug,
            scroll_wait_ms=scroll_wait_ms,
            growth_timeout_ms=growth_timeout_ms,
        )
        return {s: "" for s in slugs}

    return result


def _default_output_path() -> Path:
    return Path("list") / "mangataro_slugs.txt"


def _load_existing_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    out: list[str] = []
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = (raw or "").strip()
            if line:
                out.append(line)
    return out


def _write_lines(path: Path, lines: Iterable[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for line in lines:
            f.write(f"{line}\n")


def _load_existing_pairs(path: Path) -> tuple[list[str], dict[str, str]]:
    """Load existing slug|cover pairs from file"""
    if not path.exists():
        return [], {}
    order: list[str] = []
    mapping: dict[str, str] = {}
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = (raw or "").strip()
            if not line:
                continue
            if "|" in line:
                slug, cover = line.split("|", 1)
                slug = slug.strip()
                cover = cover.strip()
            else:
                slug = line
                cover = ""
            if slug and slug not in mapping:
                order.append(slug)
            if slug:
                mapping[slug] = cover
    return order, mapping


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-url", default="https://mangataro.org/browse")
    ap.add_argument("--max-pages", type=int, default=10_000)
    ap.add_argument("--delay", type=float, default=0.15)
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--output", type=Path, default=_default_output_path())
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--cookies", default=None)
    ap.add_argument("--use-playwright", action="store_true")
    ap.add_argument("--max-scrolls", type=int, default=200)
    ap.add_argument("--scroll-wait-ms", type=int, default=400)
    ap.add_argument("--growth-timeout-ms", type=int, default=5000)
    args = ap.parse_args()

    out: Path = args.output
    if not out.is_absolute():
        out = Path.cwd() / out

    parsed = urlparse(args.start_url)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit("--start-url must be an absolute URL")

    existing_order, existing_map = _load_existing_pairs(out)

    scraped = scrape_slugs(
        args.start_url,
        args.max_pages,
        args.delay,
        args.timeout,
        debug=args.debug,
        cookie_string=args.cookies,
        use_playwright=args.use_playwright,
        max_scrolls=args.max_scrolls,
        scroll_wait_ms=args.scroll_wait_ms,
        growth_timeout_ms=args.growth_timeout_ms,
    )

    new_count = 0
    for slug, cover in scraped.items():
        if slug not in existing_map:
            existing_order.append(slug)
            existing_map[slug] = cover
            new_count += 1

    # Write slug|cover format
    lines = [f"{slug}|{existing_map.get(slug, '')}" for slug in existing_order]
    _write_lines(out, lines)

    print(f"[mangataro] new slugs this run: {new_count}")
    print(f"[mangataro] total slugs in file: {len(existing_order)}")
    print(f"[mangataro] wrote {out}")


if __name__ == "__main__":
    main()
