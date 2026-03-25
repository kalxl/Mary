from __future__ import annotations

import re
import hashlib
import time
import json
from datetime import datetime, timezone
from typing import Dict, List, Optional
from urllib.parse import urlencode, urljoin, urlparse

from bs4 import BeautifulSoup, FeatureNotFound, NavigableString

from .base import BaseSiteHandler, SiteComicContext


class MangataroSiteHandler(BaseSiteHandler):
    name = "mangataro"
    domains = ("mangataro.org",)

    def __init__(self) -> None:
        super().__init__()
        self._has_lxml = False
        try:
            from lxml import etree  # noqa: F401
            self._has_lxml = True
        except Exception:
            self._has_lxml = False

        try:
            import brotli  # noqa: F401
            self._supports_brotli = True
        except Exception:
            self._supports_brotli = False

    # ===== NEW: Cookie handling for authentication =====
    def configure_session(self, scraper, args) -> None:
        """Configure session with authentication cookies"""
        
        accept_encoding = "gzip, deflate, br" if self._supports_brotli else "gzip, deflate"

        scraper.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": accept_encoding,
            "Referer": "https://mangataro.org/",
            "Origin": "https://mangataro.org",
            "Connection": "keep-alive",
        })
        
        cookies_to_set = self._get_cookies(args)
        
        # Set cookies for both domain variants
        for domain in [".mangataro.org", "mangataro.org"]:
            for name, value in cookies_to_set.items():
                scraper.cookies.set(name, value, domain=domain, path="/")

    def _get_cookies(self, args) -> Dict[str, str]:
        """Extract cookies from args or use defaults"""
        cookies_to_set = {}
        
        cookie_string = None
        if args:
            cookie_string = (
                getattr(args, 'cookie_string', None) or
                getattr(args, 'cookies', None)
            )
        
        if cookie_string and isinstance(cookie_string, str):
            for part in cookie_string.split(";"):
                part = part.strip()
                if not part or "=" not in part:
                    continue
                name, _, value = part.partition("=")
                name = name.strip()
                value = value.strip()
                if name:
                    cookies_to_set[name] = value
        
        # Fallback cookies
        if not cookies_to_set:
            cookies_to_set = {
                "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJtYW5nYXRhcm8ub3JnIiwiYXVkIjoibWFuZ2F0YXJvLm9yZyIsImlhdCI6MTc2OTg1NDI2OSwiZXhwIjoxNzcyNDQ2MjY5LCJkYXRhIjp7ImlkIjoiMjc4MDkiLCJlbWFpbCI6InNleW5vcmExMjM0QGdtYWlsLmNvbSIsInVzZXJuYW1lIjoic2V5bm9yYTEyMzQiLCJyb2xlIjowfX0.7yeYE4CguF7v6nNdL_pPMlZvrZqhNfW_2nZvWhZwh7E",
                "cf_clearance": "VBbmoaF77m4jOJVl4_.g75yZtrjGYNMldj7BAsgAUzs-1769854192-1.2.1.1-uVwmyZBkw2dWh00WoEwlkUYdwS1D2Sz3dxyIlAoJ2FFA98y7byqZZqd7BlgCszDup4NEdQ2M0mAgVGoRC2MRbj8eAEtQ4EbSA.LR_sbBfl8X7E89F0lmOj4lijDqbqNBlWFZ8BnEeIDPTNDFnkR8VW3bVy0kS8jb6F9KfdxrFjm71YyVJUnTLbiQCME4hqJGBqwrplHRaokUbVT6qToHyDHDeCbhlmwU8gH8y2EYpeo",
                "PHPSESSID": "t8anjhfh7n5f9vsck902p7lo3v",
                "refresh_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJtYW5nYXRhcm8ub3JnIiwiYXVkIjoibWFuZ2F0YXJvLm9yZyIsImlhdCI6MTc2OTg1NDI2OSwiZXhwIjoxNzc3NjMwMjY5LCJkYXRhIjp7ImlkIjoiMjc4MDkiLCJ0eXBlIjoicmVmcmVzaCJ9fQ.rt6BDn2BXYn0AkaBdvfBwPM6gx_RxbyX-cGqSGhdMqY",
                "user_bg_mode": "default",
                "user_theme": "orange"
            }
        
        return cookies_to_set

    # ===== OLD: This worked for title/chapters UI =====
    def fetch_comic_context(self, url: str, scraper, make_request) -> SiteComicContext:
        print(f"--- MANGATARO: Fetching URL: {url} ---")
        
        html = make_request(url, scraper).text
        print(f"--- MANGATARO: Received HTML, length: {len(html)} bytes ---")
        
        parser = "lxml" if self._has_lxml else "html.parser"
        try:
            soup = BeautifulSoup(html, parser)
        except FeatureNotFound:
            soup = BeautifulSoup(html, "html.parser")

        title = self._extract_title(soup)
        if not title:
            slug_fallback = self._extract_slug(url)
            if slug_fallback:
                title = slug_fallback.replace("-", " ").strip().title() or slug_fallback
                print(f"--- MANGATARO: Falling back to slug-derived title: {title} ---")
            else:
                # Debug: print first 1000 chars of HTML to see structure
                print("--- MANGATARO: HTML PREVIEW ---")
                print(html[:1000])
                print("--- END HTML PREVIEW ---")
                raise RuntimeError("Unable to determine series title.")

        slug = self._extract_slug(url)
        comic_data: Dict[str, object] = {"hid": slug, "title": title}

        description = self._extract_description(soup)
        if description:
            comic_data["desc"] = description

        return SiteComicContext(comic=comic_data, title=title, identifier=slug, soup=soup)

    def extract_additional_metadata(self, context: SiteComicContext) -> Dict[str, List[str]]:
        soup = context.soup
        if soup is None:
            return {}

        metadata: Dict[str, List[str]] = {}

        authors = self._extract_people(soup, ("author",))
        artists = self._extract_people(soup, ("artist", "illustrator"))
        if authors:
            metadata["authors"] = authors
        if artists:
            metadata["artists"] = artists

        genres = self._extract_tag_list(soup, "/genre/")
        themes = self._extract_tag_list(soup, "/tag/")
        if genres:
            metadata["genres"] = genres
        if themes:
            metadata["theme"] = themes

        return metadata

    # ===== OLD: This worked for chapters =====
    def get_chapters(self, context: SiteComicContext, scraper, language: str, make_request) -> List[Dict]:
        soup = context.soup
        if soup is None:
            raise RuntimeError("Comic page HTML not available for parsing.")

        chapter_links = soup.select("a[data-chapter-id]")
        chapters = self._parse_chapter_links(chapter_links)
        if chapters:
            return chapters

        manga_id = self._extract_manga_id(soup)
        if not manga_id:
            return []

        api_chapters = self._fetch_chapters_via_api(manga_id, scraper, make_request)
        return api_chapters

    def get_group_name(self, chapter_version: Dict) -> Optional[str]:
        group_name = chapter_version.get("group_name")
        if isinstance(group_name, str) and group_name.strip():
            cleaned = group_name.strip().strip("—").strip()
            return cleaned or None
        return None

    # ===== NEW: Fixed image fetching with API endpoint =====
    def get_chapter_images(self, chapter: Dict, scraper, make_request) -> List[str]:
        chapter_url = chapter.get("url")
        if not chapter_url:
            raise RuntimeError("Chapter URL missing.")

        # Extract chapter_id from URL or chapter dict
        chapter_id = chapter.get("hid")
        if not chapter_id:
            # Try to extract from URL: /read/manga-slug/chX-CHAPTERID
            match = re.search(r'-(\d+)$', chapter_url.rstrip('/'))
            if match:
                chapter_id = match.group(1)
        
        if not chapter_id:
            raise RuntimeError("Could not determine chapter ID")
        
        # Use the chapter-content API endpoint
        api_url = f"https://mangataro.org/auth/chapter-content?chapter_id={chapter_id}"
        
        try:
            response = make_request(api_url, scraper)
            data = response.json()
            
            # Extract images from API response
            if isinstance(data, dict) and "images" in data:
                images = data["images"]
                if isinstance(images, list):
                    return [img for img in images if isinstance(img, str) and img]
            
            # If API returns HTML content instead
            if isinstance(data, dict) and "html" in data:
                html_content = data["html"]
                soup = BeautifulSoup(html_content, "html.parser")
                image_urls = []
                for img in soup.find_all("img"):
                    src = img.get("src") or img.get("data-src")
                    if src and src.startswith("http"):
                        image_urls.append(src)
                return image_urls
                
        except Exception as e:
            # Fallback: try to extract from page HTML
            pass
        
        # Fallback to HTML parsing if API fails
        html = make_request(chapter_url, scraper).text
        image_urls = self._extract_images_from_js(html, chapter_url)
        
        if image_urls:
            return image_urls
        
        # Last resort: old extraction method
        return self._extract_images_old_method(html, chapter_url)

    def _extract_images_from_js(self, html: str, base_url: str) -> List[str]:
        """Extract chapter images from JavaScript data in the page"""
        image_urls = []
        
        # Pattern 1: Look for chapter data in script tags
        patterns = [
            r'var\s+chapterData\s*=\s*(\{[^;]+\})',
            r'const\s+chapterData\s*=\s*(\{[^;]+\})',
            r'let\s+chapterData\s*=\s*(\{[^;]+\})',
            r'chapterImages\s*=\s*(\[[^\]]+\])',
            r'var\s+images\s*=\s*(\[[^\]]+\])',
            r'const\s+images\s*=\s*(\[[^\]]+\])',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, html, re.DOTALL)
            if match:
                try:
                    data_str = match.group(1)
                    data = json.loads(data_str)
                    if isinstance(data, dict) and 'images' in data:
                        image_urls = data['images']
                        break
                    elif isinstance(data, list):
                        image_urls = data
                        break
                except:
                    pass
        
        # Pattern 2: Extract CDN URLs directly
        if not image_urls:
            cdn_pattern = r'(https://bx\d\.mangapeak\.me/storage/chapters/[a-f0-9]+/\d+[^"\'\s]+\.(?:webp|jpg|jpeg|png))'
            matches = re.findall(cdn_pattern, html, re.IGNORECASE)
            if matches:
                seen = set()
                for url in matches:
                    if url not in seen:
                        seen.add(url)
                        image_urls.append(url)
        
        # Ensure all URLs are absolute
        processed_urls = []
        for url in image_urls:
            if url.startswith("//"):
                url = "https:" + url
            elif url.startswith("/"):
                url = urljoin(base_url, url)
            elif not url.startswith("http"):
                url = urljoin(base_url, url)
            
            if url and url not in processed_urls:
                processed_urls.append(url)
        
        return processed_urls

    def _extract_images_old_method(self, html: str, chapter_url: str) -> List[str]:
        """Fallback to old extraction method from HTML"""
        parser = "lxml" if self._has_lxml else "html.parser"
        try:
            soup = BeautifulSoup(html, parser)
        except FeatureNotFound:
            soup = BeautifulSoup(html, "html.parser")

        candidates = []
        reader_container = None
        for selector in (
            "#readerarea",
            "[data-reader]",
            ".reading-content",
            ".reader-area",
            ".chapter-content",
        ):
            reader_container = soup.select_one(selector)
            if reader_container:
                break
        
        if reader_container:
            candidates.extend(reader_container.find_all("img"))
        else:
            candidates.extend(soup.find_all("img"))

        image_urls = []
        for img in candidates:
            src = (
                img.get("data-src")
                or img.get("data-original")
                or img.get("src")
                or _first_src_from_srcset(img)
            )
            if not src:
                continue
            src = src.strip()
            if not src:
                continue
            if _looks_like_non_page_asset(src, img):
                continue
            if src.startswith("//"):
                src = "https:" + src
            elif src.startswith("/"):
                src = urljoin(chapter_url, src)
            elif not src.startswith("http"):
                src = urljoin(chapter_url, src)

            if not _looks_like_page_image(src):
                continue

            if src not in image_urls:
                image_urls.append(src)

        return image_urls

    # ===== OLD: Helper methods that worked =====
    def _extract_slug(self, url: str) -> str:
        parsed = urlparse(url)
        parts = [p for p in parsed.path.split("/") if p]
        if parts:
            return parts[-1]
        return parsed.netloc

    def _extract_title(self, soup: BeautifulSoup) -> Optional[str]:
        print("--- MANGATARO: Attempting to extract title ---")
        
        def _clean(text: Optional[str]) -> Optional[str]:
            if not text:
                return None
            cleaned = text.strip()
            return cleaned or None

        # Try og:title meta tag
        meta = soup.find("meta", property="og:title")
        if meta and meta.get("content"):
            title = _clean(meta.get("content"))
            if title:
                print(f"--- MANGATARO: Found title in og:title meta tag: {title} ---")
                return title
        else:
            print("--- MANGATARO: og:title meta tag not found ---")
        
        # Try other meta variants
        for prop in ("twitter:title", "name"):
            meta_alt = soup.find("meta", attrs={"name": prop})
            if meta_alt and meta_alt.get("content"):
                title = _clean(meta_alt.get("content"))
                if title:
                    print(f"--- MANGATARO: Found title in meta[{prop}]: {title} ---")
                    return title

        # Try h1/h2
        h1 = soup.find(["h1", "h2"])
        if h1:
            title = _clean(h1.get_text(" ", strip=True))
            if title:
                print(f"--- MANGATARO: Found title in h1/h2: {title} ---")
                return title
        else:
            print("--- MANGATARO: h1/h2 not found ---")
        
        # Try other common selectors
        title_elem = soup.select_one(".post-title, .entry-title, .manga-title, [itemprop='name']")
        if title_elem:
            title = _clean(title_elem.get_text(" ", strip=True))
            if title:
                print(f"--- MANGATARO: Found title in common selector: {title} ---")
                return title

        # Look inside JSON-LD script tags
        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            try:
                data = json.loads(script.string or "")
            except Exception:
                continue
            if isinstance(data, dict):
                candidate = _clean(data.get("name") or data.get("headline"))
                if candidate:
                    print("--- MANGATARO: Found title in JSON-LD ---")
                    return candidate
            elif isinstance(data, list):
                for entry in data:
                    if isinstance(entry, dict):
                        candidate = _clean(entry.get("name") or entry.get("headline"))
                        if candidate:
                            print("--- MANGATARO: Found title in JSON-LD list ---")
                            return candidate

        # Fall back to <title> tag
        title_tag = soup.find("title")
        if title_tag:
            title = _clean(title_tag.get_text())
            if title:
                print("--- MANGATARO: Found title in <title> tag ---")
                return title

        print("--- MANGATARO: Title not found anywhere! ---")
        return None

    def _extract_description(self, soup: BeautifulSoup) -> Optional[str]:
        meta = soup.find("meta", property="og:description")
        if meta and meta.get("content"):
            desc = meta["content"].strip()
            if desc:
                return desc
        paragraph = soup.find("p", class_=re.compile("description", re.I))
        if paragraph:
            text = paragraph.get_text(" ", strip=True)
            if text:
                return text
        return None

    def _extract_people(self, soup: BeautifulSoup, keywords: tuple[str, ...]) -> List[str]:
        results: List[str] = []
        keyword_re = re.compile("|".join(re.escape(k) for k in keywords), re.I)

        for label in soup.find_all(string=keyword_re):
            parent = label.parent
            if not parent:
                continue
            candidate = parent.find_previous_sibling()
            if not candidate:
                continue
            text = candidate.get_text(" ", strip=True)
            if not text:
                continue
            results.extend(_split_people(text))

        seen = set()
        unique: List[str] = []
        for name in results:
            if name not in seen:
                seen.add(name)
                unique.append(name)
        return unique

    def _extract_tag_list(self, soup: BeautifulSoup, path_fragment: str) -> List[str]:
        tags: List[str] = []
        selector = f'a[href*="{path_fragment}"]'
        for anchor in soup.select(selector):
            text = anchor.get_text(" ", strip=True)
            if text:
                tags.append(text)

        seen = set()
        unique: List[str] = []
        for tag in tags:
            if tag not in seen:
                seen.add(tag)
                unique.append(tag)
        return unique

    def _extract_chapter_number(self, link) -> Optional[str]:
        fields = [
            link.get("data-number"),
            link.get("data-chapter"),
            link.get("title"),
            link.get_text(" ", strip=True),
        ]
        for field in fields:
            if not field:
                continue
            match = re.search(r"(\d+(?:\.\d+)?)", field)
            if match:
                return match.group(1)
        return None

    def _parse_chapter_links(self, chapter_links) -> List[Dict]:
        chapters: List[Dict] = []
        seen_ids = set()

        for link in chapter_links:
            chapter_id = (link.get("data-chapter-id") or "").strip()
            if not chapter_id or chapter_id in seen_ids:
                continue
            seen_ids.add(chapter_id)

            href = link.get("href")
            if not href:
                continue
            chapter_url = urljoin("https://mangataro.org/", href)

            chap_number = self._extract_chapter_number(link)
            if chap_number is None:
                continue

            group_name = (link.get("data-group-name") or "").strip() or None

            chapters.append(
                {
                    "hid": chapter_id,
                    "chap": chap_number,
                    "url": chapter_url,
                    "group_name": group_name,
                    "title": (link.get("title") or "").strip() or None,
                }
            )

        return chapters

    def _extract_manga_id(self, soup: BeautifulSoup) -> Optional[str]:
        container = soup.select_one(".chapter-list[data-manga-id]")
        if container:
            manga_id = (container.get("data-manga-id") or "").strip()
            if manga_id:
                return manga_id
        body = soup.find("body", attrs={"data-manga-id": True})
        if body:
            manga_id = (body.get("data-manga-id") or "").strip()
            if manga_id:
                return manga_id
        generic = soup.find(attrs={"data-manga-id": True})
        if generic:
            manga_id = (generic.get("data-manga-id") or "").strip()
            if manga_id:
                return manga_id
        return None

    def _fetch_chapters_via_api(self, manga_id: str, scraper, make_request) -> List[Dict]:
        token, timestamp = self._generate_api_signature()
        params = {
            "manga_id": manga_id,
            "offset": 0,
            "limit": 500,
            "order": "DESC",
            "_t": token,
            "_ts": timestamp,
        }
        api_url = (
            "https://mangataro.org/auth/manga-chapters?"
            + urlencode(params, doseq=True)
        )

        try:
            response = make_request(api_url, scraper)
            data = response.json()
        except Exception:
            return []

        if not isinstance(data, dict) or not data.get("success"):
            return []

        entries = data.get("chapters") or []
        chapters: List[Dict] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            chapter_id = (entry.get("id") or "").strip()
            if not chapter_id:
                continue
            chapter_url = entry.get("url") or ""
            if not chapter_url:
                continue
            chapter_url = urljoin("https://mangataro.org/", chapter_url)
            chap_number = (entry.get("chapter") or "").strip()
            if not chap_number:
                continue

            likes_raw = entry.get("likes")
            try:
                likes = int(likes_raw)
            except Exception:
                likes = 0

            chapters.append(
                {
                    "hid": chapter_id,
                    "chap": chap_number,
                    "url": chapter_url,
                    "group_name": (entry.get("group_name") or "").strip() or None,
                    "title": (entry.get("title") or "").strip() or None,
                    "lang": (entry.get("language") or "").strip() or None,
                    "up_count": likes,
                }
            )

        return chapters

    def _generate_api_signature(self) -> tuple[str, int]:
        timestamp = int(time.time())
        hour = datetime.now(timezone.utc).strftime("%Y%m%d%H")
        secret = f"mng_ch_{hour}"
        digest = hashlib.md5(f"{timestamp}{secret}".encode("utf-8")).hexdigest()
        return digest[:16], timestamp


def _split_people(text: str) -> List[str]:
    parts = re.split(r"[,&/]+", text)
    return [p.strip() for p in parts if p.strip()]


def _looks_like_page_image(url: str) -> bool:
    lowered = url.lower()
    if any(ext in lowered for ext in (".jpg", ".jpeg", ".png", ".webp", ".avif")):
        return True
    return False


def _looks_like_non_page_asset(url: str, tag) -> bool:
    lowered = url.lower()
    if any(
        keyword in lowered
        for keyword in (
            "group-avatars",
            "avatars/",
            "tarop.png",
            "logo",
            "banner",
        )
    ):
        return True

    classes = " ".join(tag.get("class", [])).lower()
    if any(
        keyword in classes
        for keyword in ("avatar", "logo", "banner", "author-avatar")
    ):
        return True

    alt = (tag.get("alt") or "").lower()
    if any(keyword in alt for keyword in ("avatar", "logo", "banner")):
        return True

    return False


def _first_src_from_srcset(tag) -> Optional[str]:
    srcset = tag.get("data-srcset") or tag.get("srcset")
    if not srcset:
        return None
    first = srcset.split(",")[0].strip()
    if not first:
        return None
    return first.split(" ")[0]


__all__ = ["MangataroSiteHandler"]