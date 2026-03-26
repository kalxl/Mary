from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional

import requests

try:
    import cloudscraper  # type: ignore
except Exception:
    cloudscraper = None

# Allow running this file directly without installing the project as a package.
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from sites.asura import AsuraSiteHandler


def create_session(*, use_cloudflare: bool) -> requests.Session:
    if use_cloudflare and cloudscraper is not None:
        try:
            return cloudscraper.create_scraper(
                browser={"browser": "chrome", "platform": "windows", "mobile": False}
            )
        except Exception:
            pass
    return requests.Session()


def simple_request(url: str, session: requests.Session) -> requests.Response:
    resp = session.get(url, timeout=25)
    resp.raise_for_status()
    return resp


def _format_preview(items: List[Dict[str, Any]], n: int = 5) -> Dict[str, Any]:
    return {
        "count": len(items),
        "first": items[:n],
        "last": items[-n:] if len(items) > n else [],
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Debug Asura scraping without deploying")
    parser.add_argument("--slug", required=True, help="Asura slug like nano-machine-f6174291")
    parser.add_argument(
        "--base",
        default="https://asurascans.com",
        help="Base domain (default: https://asurascans.com)",
    )
    parser.add_argument(
        "--candidate",
        action="append",
        default=[],
        help="Extra candidate series URL(s) to try (can be passed multiple times)",
    )
    parser.add_argument(
        "--use-cloudflare",
        action="store_true",
        help="Use cloudscraper when available",
    )
    parser.add_argument(
        "--chapter",
        default=None,
        help="Optional chapter number to fetch pages for (e.g. 1 or 320)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print full JSON payload",
    )

    args = parser.parse_args(argv)

    slug = str(args.slug).strip().strip("/")
    base = str(args.base).strip().rstrip("/")

    candidates = list(args.candidate or [])
    # Prioritize asurascans.com/comics which is the current working domain
    candidates.extend(
        [
            f"{base}/comics/{slug}",
            f"{base}/series/{slug}",
            "https://asuracomic.net/series/" + slug,
        ]
    )

    handler = AsuraSiteHandler()
    session = create_session(use_cloudflare=bool(args.use_cloudflare))
    handler.configure_session(session, None)

    last_exc: Optional[Exception] = None
    context = None
    chapters: List[Dict[str, Any]] = []
    used_url: Optional[str] = None

    for url in candidates:
        try:
            ctx = handler.fetch_comic_context(url, session, simple_request)
            chaps = handler.get_chapters(ctx, session, "en", simple_request)
            if chaps:
                context = ctx
                chapters = chaps
                used_url = url
                break
            context = ctx
            used_url = url
        except Exception as exc:
            last_exc = exc
            continue

    if context is None:
        print(f"Failed to fetch context. Last error: {last_exc}", file=sys.stderr)
        return 2

    comic = context.comic or {}
    title = comic.get("name") or context.title

    # Normalize chapter numbers to strings so sorting/uniqueness checks are consistent.
    normalized: List[Dict[str, Any]] = []
    for ch in chapters:
        if not isinstance(ch, dict):
            continue
        chap_no = ch.get("chap")
        chap_no_str = str(chap_no).strip() if chap_no is not None else ""
        normalized.append(
            {
                "hid": ch.get("hid"),
                "chap": chap_no_str,
                "title": ch.get("title"),
                "url": ch.get("url"),
                "group_name": ch.get("group_name"),
            }
        )

    # Sort descending numeric where possible
    def _sort_key(row: Dict[str, Any]):
        try:
            return float(row.get("chap") or "0")
        except Exception:
            return -1.0

    normalized_sorted = sorted(normalized, key=_sort_key, reverse=True)

    unique_numbers = set()
    dupes = []
    for row in normalized_sorted:
        chap_no = row.get("chap")
        if chap_no in unique_numbers:
            dupes.append(chap_no)
        unique_numbers.add(chap_no)

    out: Dict[str, Any] = {
        "used_url": used_url,
        "title": title,
        "slug": context.identifier,
        "cover": comic.get("cover") or comic.get("thumb"),
        "chapter_total": len(normalized_sorted),
        "unique_chapter_numbers": len(unique_numbers),
        "duplicate_numbers_sample": dupes[:10],
        "chapters_preview": _format_preview(normalized_sorted, 5),
    }

    if args.chapter:
        ch_no = str(args.chapter).strip()
        match = next((c for c in normalized_sorted if c.get("chap") == ch_no), None)
        if not match:
            out["chapter_pages"] = {
                "requested": ch_no,
                "error": "Chapter not found in scraped list",
            }
        else:
            try:
                page_urls = handler.get_chapter_images({"url": match.get("url")}, session, simple_request)
                out["chapter_pages"] = {
                    "requested": ch_no,
                    "page_count": len(page_urls),
                    "first_pages": page_urls[:5],
                }
            except Exception as exc:
                out["chapter_pages"] = {
                    "requested": ch_no,
                    "error": str(exc),
                }

    if args.json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print(f"used_url: {out['used_url']}")
        print(f"title: {out['title']}")
        print(f"slug: {out['slug']}")
        print(f"cover: {out['cover']}")
        print(f"chapter_total: {out['chapter_total']} (unique: {out['unique_chapter_numbers']})")
        if out.get("duplicate_numbers_sample"):
            print(f"dupes(sample): {out['duplicate_numbers_sample']}")
        preview = out.get("chapters_preview") or {}
        print("first:")
        for row in preview.get("first") or []:
            print(f"  ch {row.get('chap')}: {row.get('url')}")
        print("last:")
        for row in preview.get("last") or []:
            print(f"  ch {row.get('chap')}: {row.get('url')}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
