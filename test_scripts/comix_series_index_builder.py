import argparse
import json
import re
import time
from pathlib import Path
from typing import Dict, List, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

BASE_URL = "https://comix.to"

# UPDATED: no genre filters
LIST_API_QUERY = (
    "order[views_30d]=desc"
    "&genres_mode=or&limit=28"
)

MAX_WORKERS = 8  # safe threading limit


# -------------------- SESSION --------------------

def build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": f"{BASE_URL}/",
        "Origin": BASE_URL,
    })
    return s


# -------------------- LIST PAGE --------------------

def scrape_browser_page(session: requests.Session, page: int) -> List[Tuple[str, str]]:
    url = f"{BASE_URL}/api/v2/manga?{LIST_API_QUERY}&page={page}"
    print(f"[list] page {page}")
    r = session.get(url, timeout=25)
    r.raise_for_status()

    data = r.json()
    items = data.get("result", {}).get("items", [])
    out = []

    for it in items:
        if not isinstance(it, dict):
            continue
        hid = it.get("hash_id")
        slug = it.get("slug")
        title = (it.get("title") or "").strip()
        if hid and slug and title:
            out.append((f"{hid}-{slug}", title))

    return out


# -------------------- DETAIL PAGE --------------------

_AL = re.compile(r"anilist\.co/manga/(\d+)")
_MAL = re.compile(r"myanimelist\.net/manga/(\d+)")
_MU = re.compile(r"mangaupdates\.com/series/([^/?#]+)")


def extract_external_ids(links: Dict[str, object]) -> Dict[str, str]:
    out = {}
    if not isinstance(links, dict):
        return out

    if isinstance(links.get("al"), str):
        m = _AL.search(links["al"])
        if m:
            out["al"] = m.group(1)

    if isinstance(links.get("mal"), str):
        m = _MAL.search(links["mal"])
        if m:
            out["mal"] = m.group(1)

    if isinstance(links.get("mu"), str):
        m = _MU.search(links["mu"])
        if m:
            out["mu"] = m.group(1)

    return out


def fetch_detail(session: requests.Session, slug: str) -> Tuple[str, Dict[str, str]]:
    hid = slug.split("-", 1)[0]
    url = f"{BASE_URL}/api/v2/manga/{hid}"
    r = session.get(url, timeout=25)
    r.raise_for_status()
    data = r.json()
    links = data.get("result", {}).get("links", {})
    return slug, extract_external_ids(links)


# -------------------- INDEX IO --------------------

def load_index(path: Path) -> Dict[str, Dict[str, str]]:
    if not path.exists():
        return {"al": {}, "mal": {}, "mu": {}}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    for k in ("al", "mal", "mu"):
        data.setdefault(k, {})
    return data


def save_index(path: Path, index: Dict[str, Dict[str, str]]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)


# -------------------- MAIN LOGIC --------------------

def build_index(start: int, end: int, delay: float, output: Path):
    session = build_session()
    index = load_index(output)

    known_slugs = set()
    for b in index.values():
        known_slugs.update(b.values())

    total = 0
    added = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for page in range(start, end + 1):
            try:
                titles = scrape_browser_page(session, page)
            except Exception as e:
                print(f"[error] list page {page}: {e}")
                continue

            futures = {}
            for slug, _ in titles:
                if slug in known_slugs:
                    continue
                futures[pool.submit(fetch_detail, session, slug)] = slug

            for f in as_completed(futures):
                total += 1
                try:
                    slug, ids = f.result()
                except Exception:
                    continue

                if not ids:
                    continue

                for kind in ("mu", "mal", "al"):
                    val = ids.get(kind)
                    if val:
                        index.setdefault(kind, {}).setdefault(val, slug)

                known_slugs.add(slug)
                added += 1

                if added % 20 == 0:
                    print(f"[+] {added} mappings")

            save_index(output, index)
            if delay:
                time.sleep(delay)

    print(
        f"DONE → scanned ~{total} titles | "
        f"al={len(index['al'])} mal={len(index['mal'])} mu={len(index['mu'])}"
    )


# -------------------- CLI --------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-page", type=int, default=1)
    ap.add_argument("--end-page", type=int, default=2440)
    ap.add_argument("--delay", type=float, default=0.5)
    ap.add_argument(
        "--output",
        type=Path,
        default=Path("webapp/static/comix_links_index.json"),
    )
    args = ap.parse_args()

    out = args.output
    if not out.is_absolute():
        out = Path.cwd() / out

    build_index(args.start_page, args.end_page, args.delay, out)


if __name__ == "__main__":
    main()
