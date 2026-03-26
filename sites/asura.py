from __future__ import annotations

import json
import re
from typing import Dict, List, Optional
from urllib.parse import urlparse, urljoin

from bs4 import BeautifulSoup

from .base import BaseSiteHandler, SiteComicContext


class AsuraSiteHandler(BaseSiteHandler):
    name = "asura"
    domains = (
        "asuracomic.net",
        "www.asuracomic.net",
        "asurascans.net",
        "www.asurascans.net",
        "asurascans.com",
        "www.asurascans.com",
    )

    def configure_session(self, scraper, args) -> None:
        if "Referer" not in scraper.headers:
            scraper.headers.update(
                {
                    "Referer": "https://asuracomic.net/",
                    "Origin": "https://asuracomic.net",
                }
            )

    def _looks_like_astro(self, html: str) -> bool:
        # asurascans.com is built with Astro and embeds useful SEO meta/JSON-LD.
        if not html:
            return False
        return (
            "Astro v" in html
            or "_astro/" in html
            or 'name="generator" content="Astro' in html
        )

    def _parse_astro_series_page(self, html: str, url: str) -> Dict[str, object]:
        """Extract minimal comic metadata + chapter links from Astro-rendered pages."""
        soup = BeautifulSoup(html, "html.parser")
        comic: Dict[str, object] = {}

        og_title = soup.select_one('meta[property="og:title"]')
        og_image = soup.select_one('meta[property="og:image"]')
        og_desc = soup.select_one('meta[property="og:description"]')

        title = og_title.get("content") if og_title else None
        cover = og_image.get("content") if og_image else None
        desc = og_desc.get("content") if og_desc else None

        if title:
            # Common format: "Nano Machine | Asura Scans"
            cleaned = title.split("|")[0].strip()
            comic["name"] = cleaned or title
        if cover:
            comic["cover"] = cover
        if desc:
            comic["desc"] = desc

        # JSON-LD sometimes contains richer ComicSeries info.
        for tag in soup.select('script[type="application/ld+json"]'):
            try:
                payload = json.loads(tag.get_text(strip=True) or "")
            except Exception:
                continue
            if isinstance(payload, dict) and payload.get("@type") == "ComicSeries":
                if not comic.get("name") and payload.get("name"):
                    comic["name"] = payload.get("name")
                if not comic.get("desc") and payload.get("description"):
                    comic["desc"] = payload.get("description")
                if not comic.get("cover") and payload.get("image"):
                    comic["cover"] = payload.get("image")
                genre = payload.get("genre")
                if genre and not comic.get("genres"):
                    if isinstance(genre, list):
                        comic["genres"] = [{"name": str(g)} for g in genre if str(g).strip()]
                    elif isinstance(genre, str):
                        comic["genres"] = [{"name": g.strip()} for g in genre.split(",") if g.strip()]

        parsed = urlparse(url)
        base_url = f"{parsed.scheme}://{parsed.netloc}"

        # Scrape chapter links.
        chapter_urls: List[str] = []
        for a in soup.select('a[href*="/chapter/"]'):
            href = a.get("href")
            if not href:
                continue
            abs_url = urljoin(base_url, href)
            if "/chapter/" not in abs_url:
                continue
            chapter_urls.append(abs_url)

        # De-dupe while preserving order.
        seen = set()
        unique_chapters: List[str] = []
        for u in chapter_urls:
            if u in seen:
                continue
            seen.add(u)
            unique_chapters.append(u)

        return {"comic": comic, "chapter_urls": unique_chapters}

    # -- Helpers -----------------------------------------------------
    def _fetch_html(self, url: str, scraper, make_request) -> str:
        response = make_request(url, scraper)
        response.encoding = response.encoding or "utf-8"
        return response.text

    def _extract_flight_content(self, html: str) -> str:
        """
        Next.js App Router streams data via self.__next_f pushes. We decode the
        escaped payload into plain text for easier parsing.
        """
        chunks: List[str] = []
        # Example forms we've seen:
        #   self.__next_f.push([1,"..."])
        #   self.__next_f.push([0,"..."])
        # Payload is a JS string with unicode escapes.
        pattern = re.compile(
            r"self\.__next_f\.push\(\[(?:0|1),\s*\"(?P<payload>(?:\\\\.|[^\"])*)\"\]\)",
            re.MULTILINE,
        )
        for match in pattern.finditer(html):
            raw = match.group("payload")
            try:
                chunks.append(bytes(raw, "utf-8").decode("unicode_escape"))
            except Exception:
                chunks.append(raw)

        # Fallback to the older, simpler substring scan if regex misses.
        if not chunks:
            search = 'self.__next_f.push([1,"'
            idx = 0
            while True:
                start = html.find(search, idx)
                if start == -1:
                    break
                start += len(search)
                end = html.find('"])', start)
                if end == -1:
                    break
                raw = html[start:end]
                try:
                    chunks.append(bytes(raw, "utf-8").decode("unicode_escape"))
                except Exception:
                    chunks.append(raw)
                idx = end

        return "\n".join(chunks)

    def _extract_json_block(self, text: str, pattern: str) -> Optional[Dict]:
        idx = text.find(pattern)
        if idx == -1:
            return None
        start = text.find("{", idx)
        if start == -1:
            return None
        depth = 0
        for i in range(start, len(text)):
            ch = text[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    block = text[start : i + 1]
                    return json.loads(block)
        return None

    def _extract_array_block(self, text: str, pattern: str) -> Optional[List]:
        idx = text.find(pattern)
        if idx == -1:
            return None
        start = text.find("[", idx)
        if start == -1:
            return None
        depth = 0
        for i in range(start, len(text)):
            ch = text[i]
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    block = text[start : i + 1]
                    return json.loads(block)
        return None

    def _build_pointer_map(self, content: str) -> Dict[str, object]:
        pattern = re.compile(r"^([0-9a-z]+):(.*)$", re.MULTILINE)
        values: Dict[str, object] = {}
        for match in pattern.finditer(content):
            key = match.group(1)
            raw = match.group(2).strip()
            if not raw:
                continue
            if raw.startswith("$"):
                values[key] = raw
                continue
            if raw.startswith('"'):
                try:
                    values[key] = json.loads(raw)
                except json.JSONDecodeError:
                    values[key] = raw
                continue
            try:
                if raw.startswith("[") or raw.startswith("{"):
                    values[key] = json.loads(raw)
                else:
                    values[key] = raw
            except json.JSONDecodeError:
                values[key] = raw
        return values

    def _resolve(
        self,
        value,
        mapping: Dict[str, object],
        visited: Optional[set] = None,
    ):
        if visited is None:
            visited = set()
        if isinstance(value, str) and value.startswith("$"):
            token = value[1:]
            if token in visited:
                return None
            visited.add(token)
            return self._resolve(mapping.get(token), mapping, visited)
        if isinstance(value, list):
            return [self._resolve(v, mapping, set()) for v in value]
        if isinstance(value, dict):
            return {k: self._resolve(v, mapping, set()) for k, v in value.items()}
        return value

    def _find_chapter_map(self, mapping: Dict[str, object]) -> Optional[List[Dict]]:
        for value in mapping.values():
            resolved = self._resolve(value, mapping)
            if (
                isinstance(resolved, list)
                and resolved
                and isinstance(resolved[0], dict)
                and {"label", "value"}.issubset(resolved[0].keys())
            ):
                return resolved
        return None

    def _find_pages(self, mapping: Dict[str, object]) -> Optional[List[Dict]]:
        for value in mapping.values():
            resolved = self._resolve(value, mapping)
            if (
                isinstance(resolved, list)
                and resolved
                and isinstance(resolved[0], dict)
                and {"order", "url"}.issubset(resolved[0].keys())
            ):
                return resolved
        return None

    def _split_people(self, text: str) -> List[str]:
        parts = re.split(r"[,/]", text)
        return [p.strip() for p in parts if p.strip()]

    def _extract_people_from_html(self, html: str) -> Dict[str, List[str]]:
        soup = BeautifulSoup(html, "html.parser")
        authors: List[str] = []
        artists: List[str] = []
        info_section = soup.select_one(
            "div.grid.grid-cols-1.md\\:grid-cols-2.gap-5.mt-8"
        )
        if info_section:
            for row in info_section.find_all("div", recursive=False):
                labels = row.find_all("h3")
                if len(labels) < 2:
                    continue
                label_text = labels[0].get_text(strip=True).lower()
                value_text = labels[1].get_text(strip=True)
                if "author" in label_text or "writer" in label_text:
                    authors = self._split_people(value_text)
                elif "artist" in label_text or "illustrator" in label_text:
                    artists = self._split_people(value_text)
        result: Dict[str, List[str]] = {}
        if authors:
            result["authors"] = authors
        if artists:
            result["artists"] = artists
            if not authors:
                result.setdefault("authors", artists)
        return result

    def _parse_chapter_page(self, html: str) -> Dict:
        content = self._extract_flight_content(html)
        if not content:
            # Some deployments embed JSON directly in HTML instead of flight pushes.
            content = html
        pointer_map = self._build_pointer_map(content)
        comic = self._extract_json_block(content, '"comic":{')
        chapter = self._extract_json_block(content, '"chapter":{"id"')
        chapter_map = self._extract_array_block(content, '"chapterMapData":[')
        if comic:
            comic = self._resolve(comic, pointer_map)
        if chapter:
            chapter = self._resolve(chapter, pointer_map)
        if chapter_map:
            chapter_map = self._resolve(chapter_map, pointer_map)
        else:
            chapter_map = self._find_chapter_map(pointer_map) or []
        if chapter and not chapter.get("pages"):
            chapter["pages"] = self._find_pages(pointer_map) or []

        # Extra fallback: parse basic metadata from HTML head if JSON parsing fails.
        if not comic:
            soup = BeautifulSoup(html, "html.parser")
            og_title = soup.select_one('meta[property="og:title"]')
            og_image = soup.select_one('meta[property="og:image"]')
            title = og_title.get("content") if og_title else None
            image = og_image.get("content") if og_image else None
            comic = {}
            if title:
                comic["name"] = title
            if image:
                comic["cover"] = image

        return {
            "comic": comic or {},
            "chapter": chapter or {},
            "chapter_map": chapter_map or [],
            "pointers": pointer_map,
        }

    def _chapter_url(self, base: str, slug: str, chapter_value: str) -> str:
        return f"{base}/series/{slug}/chapter/{chapter_value}"

    # -- Base overrides ----------------------------------------------
    def fetch_comic_context(
        self, url: str, scraper, make_request
    ) -> SiteComicContext:
        html = self._fetch_html(url, scraper, make_request)
        data = self._parse_chapter_page(html)
        comic = data["comic"] or {}

        # Astro pages (asurascans.com) no longer include Next.js flight payload.
        chapter_urls: List[str] = []
        if self._looks_like_astro(html):
            astro = self._parse_astro_series_page(html, url)
            astro_comic = astro.get("comic") or {}
            if isinstance(astro_comic, dict):
                for k, v in astro_comic.items():
                    if k not in comic or comic.get(k) in (None, "", []):
                        comic[k] = v
            astro_chapters = astro.get("chapter_urls") or []
            if isinstance(astro_chapters, list):
                chapter_urls = [str(u) for u in astro_chapters if isinstance(u, str) and u.strip()]

        if not comic:
            raise RuntimeError("Unable to parse comic metadata from Asura page.")

        parsed = urlparse(url)
        base_url = f"{parsed.scheme}://{parsed.netloc}"
        slug = comic.get("slug") or self._slug_from_url(url)
        title = comic.get("name") or slug
        comic.setdefault("slug", slug)
        comic.setdefault("name", title)
        comic.setdefault("hid", str(comic.get("id") or slug))
        if comic.get("thumb") and not comic.get("cover"):
            comic["cover"] = comic["thumb"]
        comic["_base_url"] = base_url
        extra_people = self._extract_people_from_html(html)
        for key, value in extra_people.items():
            if value:
                comic[key] = value

        # inject helpers
        comic["_chapter_map"] = data.get("chapter_map", [])
        if chapter_urls:
            comic["_chapter_urls"] = chapter_urls

        if not comic["_chapter_map"]:
            series_url = self._series_base(base_url, slug)
            series_html = self._fetch_html(series_url, scraper, make_request)
            series_data = self._parse_chapter_page(series_html)
            if series_data.get("chapter_map"):
                comic["_chapter_map"] = series_data["chapter_map"]
            if series_data.get("comic"):
                for key, value in series_data["comic"].items():
                    if key not in comic or comic[key] in (None, "", []):
                        comic[key] = value
            extra_people = self._extract_people_from_html(series_html)
            for key, value in extra_people.items():
                if not comic.get(key):
                    comic[key] = value
        if not comic["_chapter_map"]:
            try:
                first_html = self._fetch_html(
                    self._chapter_url(base_url, slug, "1"), scraper, make_request
                )
                first_data = self._parse_chapter_page(first_html)
                if first_data.get("chapter_map"):
                    comic["_chapter_map"] = first_data["chapter_map"]
                if first_data.get("comic"):
                    for key, value in first_data["comic"].items():
                        if key not in comic or comic[key] in (None, "", []):
                            comic[key] = value
                extra_people = self._extract_people_from_html(first_html)
                for key, value in extra_people.items():
                    if not comic.get(key):
                        comic[key] = value
            except Exception:
                pass

        return SiteComicContext(
            comic=comic,
            title=title,
            identifier=slug,
            soup=None,
        )

    def extract_additional_metadata(
        self, context: SiteComicContext
    ) -> Dict[str, List[str]]:
        comic = context.comic or {}
        metadata: Dict[str, List[str]] = {}

        description = comic.get("description") or comic.get("summary")
        if description:
            # store in comic for downstream builder
            comic["desc"] = description

        # genres may be available as a list under "genres"
        genres = comic.get("genres")
        if isinstance(genres, list):
            metadata["genres"] = [g["name"] for g in genres if isinstance(g, dict) and g.get("name")]

        # authors / artists might be included under different keys; handle gracefully
        for key, target in (("authors", "authors"), ("artists", "artists")):
            if key in comic and isinstance(comic[key], list):
                if comic[key] and isinstance(comic[key][0], dict):
                    metadata[target] = [
                        item["name"]
                        for item in comic[key]
                        if isinstance(item, dict) and item.get("name")
                    ]
                else:
                    metadata[target] = [str(item).strip() for item in comic[key] if str(item).strip()]

        return metadata

    def get_chapters(
        self, context: SiteComicContext, scraper, language: str, make_request
    ) -> List[Dict]:
        comic = context.comic or {}
        slug = context.identifier
        base_url = comic.get("_base_url") or "https://asuracomic.net"
        chapter_map: List[Dict] = context.comic.get("_chapter_map", [])
        chapters: List[Dict] = []

        # If we have scraped chapter URLs (Astro pages), build chapters from those.
        chapter_urls = comic.get("_chapter_urls")
        if isinstance(chapter_urls, list) and chapter_urls:
            normalized: List[Dict[str, str]] = []
            for u in chapter_urls:
                if not isinstance(u, str) or not u.strip():
                    continue
                parsed = urlparse(u)
                parts = [p for p in parsed.path.split("/") if p]
                chap_value: Optional[str] = None
                if "chapter" in parts:
                    idx = parts.index("chapter")
                    if idx + 1 < len(parts):
                        chap_value = parts[idx + 1]
                if not chap_value:
                    continue
                chap_no = self._normalize_chapter_number(chap_value)
                normalized.append({"chap": chap_no, "url": u})

            def _sort_key(row: Dict[str, str]):
                value = row.get("chap") or ""
                try:
                    return float(value)
                except ValueError:
                    return float("inf")

            for row in sorted(normalized, key=_sort_key):
                chap_no = row.get("chap")
                chap_url = row.get("url")
                if not chap_no or not chap_url:
                    continue
                chapters.append(
                    {
                        "hid": f"{slug}-{chap_no}",
                        "chap": chap_no,
                        "title": f"Chapter {chap_no}",
                        "url": chap_url,
                        "group_name": None,
                    }
                )
            return chapters

        normalized_entries = []
        for entry in chapter_map:
            if not isinstance(entry, dict):
                continue
            label = entry.get("label") or ""
            value = entry.get("value")
            if value is None:
                continue
            chapter_no = self._normalize_chapter_number(value)
            normalized_entries.append((chapter_no, label))

        def chapter_sort_key(item):
            chap_no, _ = item
            try:
                return float(chap_no)
            except ValueError:
                return float("inf")

        for chapter_no, label in sorted(normalized_entries, key=chapter_sort_key):
            chapters.append(
                {
                    "hid": f"{slug}-{chapter_no}",
                    "chap": chapter_no,
                    "title": label or f"Chapter {chapter_no}",
                    "url": self._chapter_url(base_url, slug, chapter_no),
                    "group_name": None,
                }
            )

        return chapters

    def get_group_name(self, chapter_version: Dict) -> Optional[str]:
        return chapter_version.get("group_name")

    def get_chapter_images(self, chapter: Dict, scraper, make_request) -> List[str]:
        chapter_url = chapter.get("url")
        if not chapter_url:
            raise RuntimeError("Chapter URL missing for Asura chapter.")

        html = self._fetch_html(chapter_url, scraper, make_request)
        data = self._parse_chapter_page(html)
        pages = data.get("chapter", {}).get("pages", [])

        image_urls: List[str] = []
        for page in sorted(
            pages,
            key=lambda p: p.get("order", 0) if isinstance(p, dict) else 0,
        ):
            if isinstance(page, dict) and page.get("url"):
                image_urls.append(page["url"])
        return image_urls

    # -- Internal helpers --------------------------------------------
    def _series_base(self, base: str, slug: str) -> str:
        return f"{base}/series/{slug}"

    def _slug_from_url(self, url: str) -> str:
        path = urlparse(url).path
        # path like /series/<slug>/chapter/<name> or /series/<slug>
        # or /comics/<slug> (Astro)
        parts = [part for part in path.split("/") if part]
        if not parts:
            return ""
        if parts[0] == "series":
            return parts[1] if len(parts) > 1 else ""
        if parts[0] == "comics":
            return parts[1] if len(parts) > 1 else ""
        return parts[0]

    def _normalize_chapter_number(self, value) -> str:
        if isinstance(value, (int, float)):
            if isinstance(value, float) and not value.is_integer():
                return str(value).rstrip("0").rstrip(".")
            return str(int(value))
        return str(value)


__all__ = ["AsuraSiteHandler"]
