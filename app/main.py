"""SimpleNotes: a tiny, database-less note app inspired by flatnotes.

Every note is a plain Markdown file in NOTES_DIR. The file name (without
.md) is the note title. Tags are words starting with "#" inside the note.
"""

import base64
import html
import json
import os
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Folders are resolved relative to the project root (the folder that contains
# app/), so the app works the same no matter where it is started from.
PROJECT_ROOT = Path(__file__).resolve().parent.parent

NOTES_DIR = Path(os.environ.get("NOTES_DIR", PROJECT_ROOT / "data")).resolve()
NOTES_DIR.mkdir(parents=True, exist_ok=True)

# Saved analytics reports (Markdown files), stored on the same disk as notes.
REPORTS_DIR = Path(
    os.environ.get("REPORTS_DIR", PROJECT_ROOT / "reports")
).resolve()
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

# Optional login. If APP_PASSWORD is empty, the app is open to everyone.
APP_USERNAME = os.environ.get("APP_USERNAME", "admin")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")

STATIC_DIR = Path(__file__).parent / "static"
INVALID_TITLE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
TAG_PATTERN = re.compile(r"(?<!\S)#([\w-]+)")

app = FastAPI(title="SimpleNotes")


# ---------- Auth ----------


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if not APP_PASSWORD or request.url.path == "/health":
        return await call_next(request)
    header = request.headers.get("Authorization", "")
    if header.startswith("Basic "):
        try:
            decoded = base64.b64decode(header[6:]).decode()
            username, _, password = decoded.partition(":")
            if secrets.compare_digest(
                username, APP_USERNAME
            ) and secrets.compare_digest(password, APP_PASSWORD):
                return await call_next(request)
        except (ValueError, UnicodeDecodeError):
            pass
    return Response(
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="SimpleNotes"'},
    )


# ---------- Helpers ----------


class NoteIn(BaseModel):
    title: str
    content: str = ""


def clean_title(title: str) -> str:
    title = title.strip()
    if not title:
        raise HTTPException(400, "Title cannot be empty.")
    if len(title) > 100:
        raise HTTPException(400, "Title is too long (max 100 characters).")
    if INVALID_TITLE_CHARS.search(title) or title.startswith("."):
        raise HTTPException(
            400, 'Title cannot start with "." or contain < > : " / \\ | ? *'
        )
    return title


def note_path(title: str) -> Path:
    path = (NOTES_DIR / f"{clean_title(title)}.md").resolve()
    if path.parent != NOTES_DIR:
        raise HTTPException(400, "Invalid title.")
    return path


def get_tags(content: str) -> list[str]:
    return sorted({tag.lower() for tag in TAG_PATTERN.findall(content)})


def note_info(path: Path, content: str | None = None) -> dict:
    if content is None:
        content = path.read_text(encoding="utf-8")
    modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    return {
        "title": path.stem,
        "modified": modified.isoformat(),
        "tags": get_tags(content),
        "snippet": content[:150],
    }


def all_notes() -> list[tuple[Path, str]]:
    return [
        (path, path.read_text(encoding="utf-8"))
        for path in NOTES_DIR.glob("*.md")
    ]


# ---------- API ----------


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/notes")
def list_notes(q: str = "", tag: str = ""):
    """List notes, newest first. `q` searches title + content,
    `tag` filters by tag (without the #)."""
    words = q.lower().split()
    results = []
    for path, content in all_notes():
        text = f"{path.stem}\n{content}".lower()
        if words and not all(word in text for word in words):
            continue
        info = note_info(path, content)
        if tag and tag.lower().lstrip("#") not in info["tags"]:
            continue
        results.append(info)
    results.sort(key=lambda note: note["modified"], reverse=True)
    return results


@app.get("/api/tags")
def list_tags():
    counts: dict[str, int] = {}
    for _, content in all_notes():
        for tag in get_tags(content):
            counts[tag] = counts.get(tag, 0) + 1
    return [{"tag": t, "count": c} for t, c in sorted(counts.items())]


@app.get("/api/notes/{title}")
def get_note(title: str):
    path = note_path(title)
    if not path.exists():
        raise HTTPException(404, "Note not found.")
    content = path.read_text(encoding="utf-8")
    return {**note_info(path, content), "content": content}


@app.post("/api/notes", status_code=201)
def create_note(note: NoteIn):
    path = note_path(note.title)
    if path.exists():
        raise HTTPException(409, "A note with this title already exists.")
    path.write_text(note.content, encoding="utf-8")
    return {**note_info(path, note.content), "content": note.content}


@app.put("/api/notes/{title}")
def update_note(title: str, note: NoteIn):
    old_path = note_path(title)
    if not old_path.exists():
        raise HTTPException(404, "Note not found.")
    new_path = note_path(note.title)
    if new_path != old_path:
        if new_path.exists():
            raise HTTPException(
                409, "A note with this title already exists."
            )
        old_path.rename(new_path)
    new_path.write_text(note.content, encoding="utf-8")
    return {**note_info(new_path, note.content), "content": note.content}


@app.delete("/api/notes/{title}", status_code=204)
def delete_note(title: str):
    path = note_path(title)
    if not path.exists():
        raise HTTPException(404, "Note not found.")
    path.unlink()


# ---------- Analytics ----------

# A "word" is a run of English letters/digits, or a single Chinese character
# (Chinese has no spaces, so each character is counted as one word).
WORD_PATTERN = re.compile(
    r"[㐀-䶿一-鿿]|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*"
)
WORDS_PER_MINUTE = 200  # typical adult reading speed
ACTIVITY_DAYS = 14  # how many days the activity chart covers
TOP_N = 10
REPORT_NAME = re.compile(r"^[\w-]+\.md$")

# Very common English words that say nothing about a note's topic.
STOPWORDS = set(
    """
    a about above after again all also am an and any are as at be because been
    before being below between both but by can could did do does doing down
    during each few for from further had has have having he her here hers him
    his how i if in into is it its itself just me more most my no nor not now
    of off on once only or other our ours out over own same she should so some
    such than that the their theirs them then there these they this those
    through to too under until up very was we were what when where which while
    who whom why will with would you your yours
    """.split()
)


def count_words(content: str) -> int:
    return len(WORD_PATTERN.findall(content))


def reading_minutes(words: int) -> int:
    """Whole minutes, rounded up; an empty note takes 0 minutes."""
    return -(-words // WORDS_PER_MINUTE)


def top_words(contents: list[str]) -> list[dict]:
    counter: Counter[str] = Counter()
    for content in contents:
        text = TAG_PATTERN.sub(" ", content)  # tags are counted separately
        for word in WORD_PATTERN.findall(text.lower()):
            if len(word) >= 3 and word not in STOPWORDS and not word.isdigit():
                counter[word] += 1
    return [{"word": w, "count": c} for w, c in counter.most_common(TOP_N)]


def to_local(dt: datetime, tz_offset_minutes: int) -> datetime:
    return dt.astimezone(timezone(timedelta(minutes=tz_offset_minutes)))


def build_stats(tz_offset_minutes: int = 0) -> dict:
    """Compute every statistic shown on the Stats page.

    tz_offset_minutes is the viewer's offset from UTC (e.g. 480 for
    Singapore), so "per day" counts match the viewer's calendar.
    """
    tz_offset_minutes = max(-14 * 60, min(14 * 60, tz_offset_minutes))
    notes = []
    tag_counts: Counter[str] = Counter()
    for path, content in all_notes():
        info = note_info(path, content)
        words = count_words(content)
        notes.append(
            {
                "title": info["title"],
                "words": words,
                "reading_minutes": reading_minutes(words),
                "tags": info["tags"],
                "modified": info["modified"],
            }
        )
        tag_counts.update(info["tags"])

    notes.sort(key=lambda note: note["words"], reverse=True)
    total_words = sum(note["words"] for note in notes)

    # Notes per day (by last-modified date) for the last ACTIVITY_DAYS days.
    today = to_local(datetime.now(timezone.utc), tz_offset_minutes).date()
    days = [today - timedelta(days=i) for i in range(ACTIVITY_DAYS - 1, -1, -1)]
    per_day = Counter(
        to_local(
            datetime.fromisoformat(note["modified"]), tz_offset_minutes
        ).date()
        for note in notes
    )

    return {
        "generated": to_local(
            datetime.now(timezone.utc), tz_offset_minutes
        ).isoformat(timespec="seconds"),
        "summary": {
            "notes": len(notes),
            "words": total_words,
            "avg_words": round(total_words / len(notes)) if notes else 0,
            "reading_minutes": reading_minutes(total_words),
            "tags": len(tag_counts),
        },
        "notes": notes,
        "top_tags": [
            {"tag": t, "count": c} for t, c in tag_counts.most_common(TOP_N)
        ],
        "top_words": top_words([content for _, content in all_notes()]),
        "activity": [
            {"date": day.isoformat(), "count": per_day.get(day, 0)}
            for day in days
        ],
    }


def stats_to_markdown(stats: dict) -> str:
    s = stats["summary"]
    lines = [
        "# SimpleNotes Analytics Report",
        "",
        f"Generated: {stats['generated']}",
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        f"| Notes | {s['notes']} |",
        f"| Total words | {s['words']} |",
        f"| Average words per note | {s['avg_words']} |",
        f"| Total reading time | {s['reading_minutes']} min |",
        f"| Distinct tags | {s['tags']} |",
        "",
        "## Notes by length",
        "",
        "| Note | Words | Reading time |",
        "| --- | --- | --- |",
    ]
    lines += [
        f"| {n['title']} | {n['words']} | {n['reading_minutes']} min |"
        for n in stats["notes"]
    ] or ["| (no notes) | | |"]

    lines += ["", "## Top tags", ""]
    lines += [f"- #{t['tag']} ({t['count']})" for t in stats["top_tags"]] or [
        "No tags yet."
    ]
    lines += ["", "## Top words", ""]
    lines += [f"- {w['word']} ({w['count']})" for w in stats["top_words"]] or [
        "No words yet."
    ]
    lines += [
        "",
        f"## Activity (notes by last-modified date, last {ACTIVITY_DAYS} days)",
        "",
        "| Date | Notes |",
        "| --- | --- |",
    ]
    lines += [f"| {d['date']} | {d['count']} |" for d in stats["activity"]]
    return "\n".join(lines) + "\n"


def report_path(name: str) -> Path:
    if not REPORT_NAME.match(name):
        raise HTTPException(400, "Invalid report name.")
    path = (REPORTS_DIR / name).resolve()
    if path.parent != REPORTS_DIR:
        raise HTTPException(400, "Invalid report name.")
    return path


@app.get("/api/stats")
def get_stats(tz_offset: int = 0):
    """Statistics about all notes. `tz_offset` = viewer's minutes ahead of UTC."""
    return build_stats(tz_offset)


@app.post("/api/reports", status_code=201)
def save_report(tz_offset: int = 0):
    """Compute the current statistics and save them as a Markdown report."""
    stats = build_stats(tz_offset)
    stamp = datetime.fromisoformat(stats["generated"]).strftime(
        "%Y-%m-%d_%H%M%S"
    )
    path = REPORTS_DIR / f"notes-report-{stamp}.md"
    number = 2
    while path.exists():  # never overwrite an earlier report
        path = REPORTS_DIR / f"notes-report-{stamp}-{number}.md"
        number += 1
    try:
        path.write_text(stats_to_markdown(stats), encoding="utf-8")
    except OSError as err:
        raise HTTPException(500, f"Could not save the report: {err}") from err
    return {"name": path.name}


@app.get("/api/reports")
def list_reports():
    """Saved reports, newest first."""
    paths = sorted(
        REPORTS_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    return [
        {
            "name": p.name,
            "created": datetime.fromtimestamp(
                p.stat().st_mtime, timezone.utc
            ).isoformat(),
        }
        for p in paths
    ]


@app.get("/api/reports/{name}")
def get_report(name: str):
    path = report_path(name)
    if not path.exists():
        raise HTTPException(404, "Report not found.")
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as err:
        raise HTTPException(500, f"Could not read the report: {err}") from err
    return {"name": name, "content": content}


# ---------- Research: Wikipedia ----------

# Wikipedia's free public API: no API key needed. Wikimedia asks every client
# to send a User-Agent that says who is calling.
WIKI_BASE = "https://en.wikipedia.org"
WIKI_USER_AGENT = (
    "SimpleNotes/1.0 (DS600 student project; "
    "https://github.com/tianjiaoma2026-lab/simplenotes)"
)
WIKI_TIMEOUT_SECONDS = 10
HTML_TAG = re.compile(r"<[^>]+>")


class WikiImport(BaseModel):
    title: str


def wiki_get(path: str, params: dict | None = None) -> dict:
    """Call the Wikipedia API and return the JSON reply as a dict."""
    url = WIKI_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": WIKI_USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(
            request, timeout=WIKI_TIMEOUT_SECONDS
        ) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        if err.code == 404:
            raise HTTPException(404, "Wikipedia article not found.") from err
        raise HTTPException(
            502, f"Wikipedia returned an error ({err.code})."
        ) from err
    except (urllib.error.URLError, TimeoutError, ValueError) as err:
        raise HTTPException(
            502, "Could not reach Wikipedia. Check the internet connection."
        ) from err


def strip_html(text: str | None) -> str:
    """Remove HTML tags (e.g. search highlights) and decode &quot; etc."""
    return html.unescape(HTML_TAG.sub("", text or "")).strip()


def wiki_page_url(key: str) -> str:
    return f"{WIKI_BASE}/wiki/{urllib.parse.quote(key)}"


def safe_note_title(title: str) -> str:
    """Wikipedia titles may contain characters a file name cannot (e.g. "/")."""
    title = INVALID_TITLE_CHARS.sub("-", title).strip().lstrip(".")
    return title[:100] or "Wikipedia article"


def wiki_note_content(summary: dict, title: str) -> str:
    """Turn a Wikipedia page summary into a Markdown note."""
    url = (
        summary.get("content_urls", {}).get("desktop", {}).get("page")
        or wiki_page_url(title.replace(" ", "_"))
    )
    lines = [f"# {title}", ""]
    if summary.get("description"):
        lines += [f"*{summary['description']}*", ""]
    lines += [
        summary.get("extract") or "No summary available.",
        "",
        "---",
        f"Source: [Wikipedia - {title}]({url}) "
        f"(imported {datetime.now(timezone.utc).date().isoformat()})",
        "",
        "#wikipedia #research",
    ]
    return "\n".join(lines) + "\n"


@app.get("/api/wiki/search")
def wiki_search(q: str, limit: int = 10):
    """Search English Wikipedia. Returns titles, short descriptions and
    a plain-text excerpt for each match."""
    q = q.strip()
    if not q:
        raise HTTPException(400, "Type something to search for.")
    limit = max(1, min(20, limit))
    data = wiki_get("/w/rest.php/v1/search/page", {"q": q, "limit": limit})
    return [
        {
            "title": page["title"],
            "key": page["key"],
            "description": page.get("description") or "",
            "excerpt": strip_html(page.get("excerpt")),
            "url": wiki_page_url(page["key"]),
        }
        for page in data.get("pages", [])
    ]


@app.post("/api/wiki/import", status_code=201)
def wiki_import(item: WikiImport):
    """Fetch a Wikipedia article summary and save it as a new note."""
    key = item.title.strip().replace(" ", "_")
    if not key:
        raise HTTPException(400, "Article title cannot be empty.")
    summary = wiki_get(
        "/api/rest_v1/page/summary/" + urllib.parse.quote(key, safe="")
    )
    title = safe_note_title(summary.get("title") or item.title)
    path = note_path(title)
    if path.exists():
        raise HTTPException(409, f'A note called "{title}" already exists.')
    content = wiki_note_content(summary, title)
    path.write_text(content, encoding="utf-8")
    return {**note_info(path, content), "content": content}


# ---------- Frontend ----------


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
