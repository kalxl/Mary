import argparse
import json
import re
from pathlib import Path
from typing import Dict, List

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://asuracomic.net"


def extract_slug_from_href(href: str) -> str | None:
    if not href:
        return None
    path = href.split("?", 1)[0]
    parts = [p for p in path.split("/") if p]
    if not parts:
        return None
    try:
        idx = parts.index("series")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    except ValueError:
        # Fallback: last path segment
        return parts[-1]
    return None


def build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            " AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": f"{BASE_URL}/",
            "Origin": BASE_URL,
        }
    )
    return s


def clean_title(raw: str) -> str:
    """Normalize Asura card titles to just the series name.

    Examples:
      'Ongoing MANHWA Solo Max-Level Newbie Chapter 242 9.5'
        -> 'Solo Max-Level Newbie'
    """
    title = (raw or "").strip()
    if not title:
        return ""

    # Drop status / type prefixes like 'Ongoing MANHWA'
    title = re.sub(r"^(Ongoing|Completed|Hiatus|Dropped)\s+\w+\s+", "", title, flags=re.IGNORECASE)

    # Cut off at 'Chapter ...'
    title = re.sub(r"\s+Chapter\s+.*$", "", title, flags=re.IGNORECASE)

    # Remove trailing rating numbers like '9.5'
    title = re.sub(r"\s+[0-9]+(\.[0-9]+)?$", "", title)

    return title.strip()

def scrape_series_page(session: requests.Session, page: int) -> List[Dict[str, str]]:
    url = f"{BASE_URL}/series?page={page}"
    print(f"[asura] Fetching page {page}: {url}")
    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    html = resp.text
    soup = BeautifulSoup(html, "html.parser")

    results: List[Dict[str, str]] = []
    # Prefer anchors inside the main 15-series grid.
    series_links = []
    grid_selectors = [
        "div.grid.grid-cols-2.sm\\:grid-cols-2.md\\:grid-cols-5",
        "div.grid.grid-cols-2.sm\\:grid-cols-5",
    ]

    for sel in grid_selectors:
        for grid in soup.select(sel):
            series_links.extend(grid.select("a[href]"))

    # Fallback to a broader selector if the layout changes.
    if not series_links:
        series_links = soup.select("a[href*='series']")

    seen_slugs = set()

    for a in series_links:
        href = a.get("href") or ""
        slug = extract_slug_from_href(href)
        if not slug or slug in seen_slugs:
            continue
        # Skip obvious chapter URLs just in case
        if "/chapter/" in href:
            continue

        # Prefer title attribute, fallback to text, then clean it up
        raw_title = (a.get("title") or a.get_text(" ", strip=True) or "").strip()
        title = clean_title(raw_title)
        if not title:
            continue

        seen_slugs.add(slug)
        results.append(
            {
                "title": title,
                "slug": slug,
                "url": f"{BASE_URL}/series/{slug}",
            }
        )

    return results


def build_index(pages: int) -> Dict[str, Dict[str, str]]:
    session = build_session()
    index: Dict[str, Dict[str, str]] = {}

    for page in range(1, pages + 1):
        try:
            items = scrape_series_page(session, page)
        except Exception as exc:  # pragma: no cover - network/HTML errors
            print(f"[asura] Failed to fetch page {page}: {exc}")
            continue

        for item in items:
            slug = item["slug"]
            # Last one wins if duplicates; that's fine for our use
            index[slug] = item

    return index


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape Asura series listing pages and build a slug index JSON file.",
    )
    parser.add_argument(
        "--pages",
        type=int,
        default=21,
        help="Number of /series?page=N pages to scrape (default: 21)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("webapp/static/series.json"),
        help=(
            "Output JSON file path (default: webapp/static/series.json, "
            "suitable for multiple sources)"
        ),
    )

    args = parser.parse_args()

    index = build_index(args.pages)
    print(f"[asura] Collected {len(index)} unique slugs")

    # Write JSON
    out_path: Path = args.output
    if not out_path.is_absolute():
        # Resolve relative to project root when run from repo root
        out_path = Path.cwd() / out_path

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"[asura] Wrote index JSON to {out_path}")


if __name__ == "__main__":
    main()
