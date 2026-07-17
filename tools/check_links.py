#!/usr/bin/env python3
"""
Link checker for jessestrait.com and its sub-projects.

Crawls the site starting from https://jessestrait.com/, following every
internal link (jessestrait.com and its subdomains) it finds, and does a
one-level check (no recursion) on external links and assets (images,
scripts, stylesheets). Reports anything that doesn't return 200.

Usage:
    python3 check_links.py [seed_url ...]

With no arguments, checks https://jessestrait.com/. Pass one or more URLs
to check other sites/subpaths instead (e.g. to check yt-recs-wordcloud
directly without re-crawling the whole site).
"""

import sys
import re
import urllib.request
import urllib.error
from urllib.parse import urljoin, urlparse

DEFAULT_SEEDS = ["https://jessestrait.com/"]
# jessestrait.github.io is included because sub-project repos (yt-recs-wordcloud,
# archetype-atlas, modal-keyboard) are linked to by that host even though the
# same content is also reachable at jessestrait.com/<repo>/ -- both need to be
# treated as "ours" so the crawler actually follows into them.
ALLOWED_HOST_SUFFIXES = ("jessestrait.com", "jessestrait.github.io")
TIMEOUT = 10
USER_AGENT = "Mozilla/5.0 (link-checker; personal site QA script)"

# Matches a whole <tag ...> so we can inspect rel= alongside href/src in one pass.
TAG_RE = re.compile(r'<[a-zA-Z][^>]*>')
ATTR_RE = re.compile(r'''(?:href|src)\s*=\s*["']([^"'#][^"']*)["']''', re.IGNORECASE)
REL_RE = re.compile(r'''rel\s*=\s*["']([^"']*)["']''', re.IGNORECASE)
# rel values that are browser resource hints, not navigable/fetchable pages
SKIP_RELS = {"preconnect", "dns-prefetch", "prefetch", "preload", "modulepreload"}


def is_internal(url):
    host = urlparse(url).netloc.lower()
    return any(host == suf or host.endswith("." + suf) for suf in ALLOWED_HOST_SUFFIXES)


def fetch(url):
    """Return (status_code_or_None, body_text_or_None, error_str_or_None)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            status = resp.status
            ctype = resp.headers.get("Content-Type", "")
            body = resp.read().decode("utf-8", errors="replace") if "text/html" in ctype else None
            return status, body, None
    except urllib.error.HTTPError as e:
        return e.code, None, None
    except Exception as e:
        return None, None, str(e)


def extract_links(base_url, html):
    links = set()
    for tag in TAG_RE.finditer(html):
        tag_text = tag.group(0)
        rel_match = REL_RE.search(tag_text)
        if rel_match and rel_match.group(1).strip().lower() in SKIP_RELS:
            continue
        attr_match = ATTR_RE.search(tag_text)
        if not attr_match:
            continue
        raw = attr_match.group(1).strip()
        if raw.startswith(("mailto:", "javascript:", "tel:", "data:")):
            continue
        links.add(urljoin(base_url, raw))
    return links


def main():
    seeds = sys.argv[1:] or DEFAULT_SEEDS

    visited = {}          # url -> (status, referrer)
    to_crawl = list(seeds)
    crawled = set()
    external_checked = set()
    failures = []

    while to_crawl:
        url = to_crawl.pop(0)
        url = url.split("#")[0]
        if url in crawled:
            continue
        crawled.add(url)

        status, body, err = fetch(url)
        visited[url] = status
        ok = status is not None and 200 <= status < 300
        if not ok:
            failures.append((url, status, err))
            print(f"[FAIL] {status or 'ERROR'} {url}" + (f"  ({err})" if err else ""))
        else:
            print(f"[ OK ] {status} {url}")

        if body and is_internal(url):
            for link in extract_links(url, body):
                link_clean = link.split("#")[0]
                if not link_clean or link_clean in crawled:
                    continue
                if is_internal(link_clean):
                    if link_clean not in to_crawl:
                        to_crawl.append(link_clean)
                else:
                    if link_clean not in external_checked and link_clean not in crawled:
                        to_crawl.append(link_clean)  # check once, won't recurse (not internal)

    print()
    print(f"Checked {len(crawled)} URLs.")
    if failures:
        print(f"\n{len(failures)} FAILURE(S):")
        for url, status, err in failures:
            print(f"  {status or 'ERROR'}  {url}" + (f"  ({err})" if err else ""))
        sys.exit(1)
    else:
        print("All links OK.")
        sys.exit(0)


if __name__ == "__main__":
    main()
