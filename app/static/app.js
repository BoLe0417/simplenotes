// SimpleNotes frontend: plain JavaScript, no build step.

const $ = (id) => document.getElementById(id);

const state = {
  current: null, // note being viewed/edited (null = new note)
  query: "",
  tag: "",
};

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

const noteUrl = (title) => `/api/notes/${encodeURIComponent(title)}`;

// ---------- Rendering ----------

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderMarkdown(content) {
  // [[Note Title]] -> link to that note
  const withLinks = content.replace(
    /\[\[([^\]]+)\]\]/g,
    (_, title) => `[${title}](#/note/${encodeURIComponent(title.trim())})`,
  );
  return DOMPurify.sanitize(marked.parse(withLinks));
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3000);
}

function show(section) {
  for (const id of ["empty", "viewer", "editor", "stats", "research"]) {
    $(id).hidden = id !== section;
  }
  $("stats-link").classList.toggle("active", section === "stats");
  $("research-link").classList.toggle("active", section === "research");
}

// Same word rule as the server: English words/numbers, or one Chinese character.
const WORD_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]|[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g;
const countWords = (text) => (text.match(WORD_PATTERN) || []).length;

// The page already shows the title, so skip a first "# Title" line that repeats it.
function withoutTitleHeading(note) {
  const [first, ...rest] = note.content.split("\n");
  return first.trim() === `# ${note.title}` ? rest.join("\n") : note.content;
}

// Plain-text preview for the sidebar: drop Markdown symbols and a first
// heading that only repeats the note title.
function previewText(note) {
  return note.snippet
    .replace(/^#\s+(.*)$/m, (line, heading) => (heading.trim() === note.title ? "" : heading))
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[#*_>`[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function loadList() {
  const params = new URLSearchParams({ q: state.query, tag: state.tag });
  const [notes, tags] = await Promise.all([
    api("GET", `/api/notes?${params}`),
    api("GET", "/api/tags"),
  ]);

  $("tags").innerHTML = tags
    .map(
      ({ tag, count }) =>
        `<button class="tag ${tag === state.tag ? "active" : ""}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} <small>${count}</small></button>`,
    )
    .join("");

  $("note-count").textContent = notes.length;
  $("note-list").innerHTML = notes.length
    ? notes
        .map(
          (note) => `
          <li class="${note.title === state.current?.title ? "active" : ""}">
            <a href="#/note/${encodeURIComponent(note.title)}">
              <strong>${escapeHtml(note.title)}</strong>
              <span class="note-snippet">${escapeHtml(previewText(note)) || "<em>Empty note</em>"}</span>
              <span class="note-info">
                <time>${timeAgo(note.modified)}</time>
                ${note.tags.slice(0, 2).map((t) => `<i>#${escapeHtml(t)}</i>`).join("")}
                ${note.tags.length > 2 ? `<i>+${note.tags.length - 2}</i>` : ""}
              </span>
            </a>
          </li>`,
        )
        .join("")
    : `<li class="none">${state.query || state.tag ? "No notes match your search" : "No notes yet"}</li>`;
}

async function openNote(title) {
  try {
    const note = await api("GET", noteUrl(title));
    state.current = note;
    $("view-title").textContent = note.title;
    renderNoteMeta(note);
    $("view-body").innerHTML = renderMarkdown(withoutTitleHeading(note));
    show("viewer");
  } catch (err) {
    toast(err.message);
    state.current = null;
    show("empty");
  }
  loadList();
}

function renderNoteMeta(note) {
  const words = countWords(note.content);
  const minutes = Math.ceil(words / 200);
  const edited = new Date(note.modified).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  $("view-meta").innerHTML = `
    <span title="Last modified">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></svg>
      ${escapeHtml(edited)}
    </span>
    <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5h16v2M12 5v14M9 19h6" /></svg>${words.toLocaleString()} words</span>
    <span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>${minutes} min read</span>
    ${note.tags.map((t) => `<button class="meta-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join("")}`;
}

function updateEditCount() {
  const words = countWords($("edit-content").value);
  $("edit-count").textContent = `${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
}

function openEditor(note) {
  state.current = note;
  $("edit-title").value = note ? note.title : "";
  $("edit-content").value = note ? note.content : "";
  $("edit-preview").innerHTML = renderMarkdown($("edit-content").value);
  updateEditCount();
  show("editor");
  (note ? $("edit-content") : $("edit-title")).focus();
}

// ---------- Actions ----------

async function save() {
  const body = {
    title: $("edit-title").value,
    content: $("edit-content").value,
  };
  try {
    const saved = state.current
      ? await api("PUT", noteUrl(state.current.title), body)
      : await api("POST", "/api/notes", body);
    toast("Saved");
    const hash = `#/note/${encodeURIComponent(saved.title)}`;
    if (location.hash === hash) openNote(saved.title);
    else location.hash = hash;
  } catch (err) {
    toast(err.message);
  }
}

async function remove() {
  if (!confirm(`Delete "${state.current.title}"?`)) return;
  try {
    await api("DELETE", noteUrl(state.current.title));
    toast("Deleted");
    location.hash = "";
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Analytics ----------

// Minutes ahead of UTC (e.g. 480 in Singapore), so "per day" uses local dates.
const tzOffset = () => -new Date().getTimezoneOffset();

const formatDate = (iso, options) =>
  new Date(iso).toLocaleString(undefined, options);

const ICONS = {
  notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  words: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
  avg: '<path d="M4 19h16M7 16V9M12 16V5M17 16v-4"/>',
  time: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  tags: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.2"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function renderStatCards(stats) {
  const { summary, notes, activity } = stats;
  const recent = activity.reduce((sum, d) => sum + d.count, 0);
  const longest = notes[0];
  const cards = [
    ["notes", "Notes", summary.notes, `${recent} edited in 14 days`],
    ["words", "Total words", summary.words.toLocaleString(), longest ? `Longest: ${longest.title}` : "No notes yet"],
    ["avg", "Avg words / note", summary.avg_words.toLocaleString(), longest ? `Max ${plural(longest.words, "word")}` : ""],
    ["time", "Total reading time", `${summary.reading_minutes} min`, "Reading at 200 words/min"],
    ["tags", "Distinct tags", summary.tags, stats.top_tags[0] ? `Most used: #${stats.top_tags[0].tag}` : "Add #tags to notes"],
  ];
  $("stat-cards").innerHTML = cards
    .map(
      ([key, label, value, hint]) => `
        <div class="stat-card stat-${key}">
          <span class="stat-icon">${icon(key)}</span>
          <span class="stat-label">${label}</span>
          <strong>${escapeHtml(String(value))}</strong>
          <small title="${escapeHtml(hint)}">${escapeHtml(hint)}</small>
        </div>`,
    )
    .join("");
}

function renderActivity(activity) {
  const max = Math.max(1, ...activity.map((d) => d.count));
  const total = activity.reduce((sum, d) => sum + d.count, 0);
  const activeDays = activity.filter((d) => d.count).length;
  const busiest = activity.reduce((a, b) => (b.count > a.count ? b : a), activity[0]);
  const longDate = (iso) =>
    new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  $("activity-summary").innerHTML = total
    ? `<strong>${plural(total, "note")}</strong> on ${plural(activeDays, "day")} · busiest: ${escapeHtml(longDate(busiest.date))}`
    : "No edits in the last 14 days";

  $("activity-chart").innerHTML = activity
    .map((d, i) => {
      const day = new Date(d.date + "T00:00:00");
      const tip = `${longDate(d.date)}: ${plural(d.count, "note")}`;
      const height = d.count ? Math.max(6, (d.count / max) * 100) : 0;
      const isToday = i === activity.length - 1;
      const weekday = day.toLocaleDateString(undefined, { weekday: "narrow" });
      return `
        <div class="activity-col${isToday ? " today" : ""}${d.count ? "" : " zero"}" title="${tip}" aria-label="${tip}">
          <span class="activity-value">${d.count || ""}</span>
          <div class="activity-track"><div class="activity-bar" style="height:${height}%"></div></div>
          <span class="activity-label"><b>${day.getDate()}</b>${isToday ? "Today" : weekday}</span>
        </div>`;
    })
    .join("");
}

function renderRankList(id, items, format) {
  const max = Math.max(1, ...items.map((i) => i.count));
  $(id).innerHTML = items.length
    ? items
        .map(
          (item, i) => `
          <li>
            <span class="rank-pos">${i + 1}</span>
            <span class="rank-name">${escapeHtml(format(item))}</span>
            <span class="rank-bar"><span style="width:${(item.count / max) * 100}%"></span></span>
            <span class="rank-count">${item.count}</span>
          </li>`,
        )
        .join("")
    : `<li class="none">Nothing yet</li>`;
}

function timeAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return formatDate(iso, { year: "numeric", month: "short", day: "numeric" });
}

function renderNotesTable(notes) {
  const max = Math.max(1, ...notes.map((n) => n.words));
  $("notes-table").innerHTML = notes.length
    ? notes
        .map(
          (n, i) => `
          <tr>
            <td class="rank">${i + 1}</td>
            <td>
              <a href="#/note/${encodeURIComponent(n.title)}">${escapeHtml(n.title)}</a>
              ${n.tags.length ? `<div class="row-tags">${n.tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join("")}</div>` : ""}
            </td>
            <td class="length"><div class="length-cell">
              <span class="length-bar"><span style="width:${(n.words / max) * 100}%"></span></span>
              <span class="length-num">${n.words.toLocaleString()}</span>
            </div></td>
            <td class="num">${n.reading_minutes} min</td>
            <td class="num muted-cell" title="${escapeHtml(formatDate(n.modified))}">${timeAgo(n.modified)}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="none">No notes yet — create one to see statistics.</td></tr>`;
}

async function loadReports() {
  try {
    const reports = await api("GET", "/api/reports");
    if (!reports.length) {
      $("reports-box").innerHTML =
        `<p class="none">No reports saved yet. Click <strong>Save Report</strong> to save the current statistics.</p>`;
      return;
    }
    $("reports-box").innerHTML = `
      <select id="report-select" aria-label="Saved reports">
        ${reports
          .map(
            (r) =>
              `<option value="${escapeHtml(r.name)}">Report — ${escapeHtml(formatDate(r.created))}</option>`,
          )
          .join("")}
      </select>
      <button id="show-report-btn">Show</button>
      <small class="muted">${reports.length} saved</small>`;
    $("show-report-btn").onclick = () => showReport($("report-select").value);
  } catch (err) {
    $("reports-box").innerHTML = `<p class="none">Could not load reports: ${escapeHtml(err.message)}</p>`;
  }
}

async function showReport(name) {
  try {
    const report = await api("GET", `/api/reports/${encodeURIComponent(name)}`);
    $("report-dialog-title").textContent = report.name;
    $("report-body").innerHTML = renderMarkdown(report.content);
    $("report-dialog").showModal();
  } catch (err) {
    toast(err.message);
  }
}

async function openStats() {
  state.current = null;
  show("stats");
  loadList();
  try {
    const stats = await api("GET", `/api/stats?tz_offset=${tzOffset()}`);
    $("stats-meta").textContent = "Updated: " + formatDate(stats.generated);
    renderStatCards(stats);
    renderActivity(stats.activity);
    renderRankList("top-tags", stats.top_tags, (t) => "#" + t.tag);
    renderRankList("top-words", stats.top_words, (w) => w.word);
    renderNotesTable(stats.notes);
  } catch (err) {
    toast(err.message);
  }
  loadReports();
}

async function saveReport() {
  try {
    const saved = await api("POST", `/api/reports?tz_offset=${tzOffset()}`);
    toast(`Report saved: ${saved.name}`);
    await loadReports();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Research (Wikipedia) ----------

function openResearch() {
  state.current = null;
  show("research");
  loadList();
  $("wiki-query").focus();
}

function renderWikiResults(results) {
  $("wiki-results").innerHTML = results.length
    ? results
        .map(
          (r) => `
          <li class="wiki-result">
            <div class="wiki-text">
              <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(r.title)}</strong></a>
              ${r.description ? `<span class="wiki-desc">${escapeHtml(r.description)}</span>` : ""}
              <p>${escapeHtml(r.excerpt)}…</p>
            </div>
            <button class="wiki-save" data-title="${escapeHtml(r.title)}">Save as note</button>
          </li>`,
        )
        .join("")
    : `<li class="none">No articles found. Try different words.</li>`;
}

async function searchWiki(event) {
  event.preventDefault();
  const query = $("wiki-query").value.trim();
  if (!query) return;
  $("wiki-results").innerHTML = `<li class="none">Searching Wikipedia…</li>`;
  try {
    const results = await api("GET", `/api/wiki/search?${new URLSearchParams({ q: query })}`);
    renderWikiResults(results);
  } catch (err) {
    $("wiki-results").innerHTML = `<li class="none">${escapeHtml(err.message)}</li>`;
  }
}

async function importWiki(button) {
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const note = await api("POST", "/api/wiki/import", { title: button.dataset.title });
    toast(`Saved as note: ${note.title}`);
    location.hash = `#/note/${encodeURIComponent(note.title)}`;
  } catch (err) {
    toast(err.message);
    button.disabled = false;
    button.textContent = "Save as note";
  }
}

function route() {
  if (location.hash === "#/stats") {
    openStats();
    return;
  }
  if (location.hash === "#/research") {
    openResearch();
    return;
  }
  const match = location.hash.match(/^#\/note\/(.+)$/);
  if (match) {
    openNote(decodeURIComponent(match[1]));
  } else {
    state.current = null;
    show("empty");
    loadList();
  }
}

// ---------- Events ----------

$("new-btn").onclick = () => openEditor(null);
$("edit-btn").onclick = () => openEditor(state.current);
$("delete-btn").onclick = remove;
$("save-report-btn").onclick = saveReport;
$("wiki-form").onsubmit = searchWiki;
$("wiki-results").onclick = (e) => {
  const button = e.target.closest(".wiki-save");
  if (button) importWiki(button);
};
$("report-close-btn").onclick = () => $("report-dialog").close();
$("save-btn").onclick = save;
$("cancel-btn").onclick = () =>
  state.current ? openNote(state.current.title) : show("empty");

$("edit-content").oninput = () => {
  $("edit-preview").innerHTML = renderMarkdown($("edit-content").value);
  updateEditCount();
};

$("empty-new-btn").onclick = () => openEditor(null);

// Clicking a tag under a note's title filters the sidebar by that tag.
$("view-meta").onclick = (e) => {
  const button = e.target.closest(".meta-tag");
  if (!button) return;
  state.tag = button.dataset.tag;
  loadList();
};

let searchTimer;
$("search").oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;
    loadList();
  }, 200);
};

$("tags").onclick = (e) => {
  const button = e.target.closest(".tag");
  if (!button) return;
  state.tag = state.tag === button.dataset.tag ? "" : button.dataset.tag;
  loadList();
};

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (e.key === "/" && !typing) {
    e.preventDefault();
    $("search").focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "s" && !$("editor").hidden) {
    e.preventDefault();
    save();
  }
});

window.addEventListener("hashchange", route);
route();
