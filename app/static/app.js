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
  for (const id of ["empty", "viewer", "editor", "stats"]) $(id).hidden = id !== section;
  $("stats-link").classList.toggle("active", section === "stats");
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

  $("note-list").innerHTML = notes.length
    ? notes
        .map(
          (note) => `
          <li class="${note.title === state.current?.title ? "active" : ""}">
            <a href="#/note/${encodeURIComponent(note.title)}">
              <strong>${escapeHtml(note.title)}</strong>
              <span>${escapeHtml(note.snippet.slice(0, 60)) || "<em>Empty note</em>"}</span>
            </a>
          </li>`,
        )
        .join("")
    : `<li class="none">No notes found</li>`;
}

async function openNote(title) {
  try {
    const note = await api("GET", noteUrl(title));
    state.current = note;
    $("view-title").textContent = note.title;
    $("view-meta").textContent =
      "Last modified: " + new Date(note.modified).toLocaleString();
    $("view-body").innerHTML = renderMarkdown(note.content);
    show("viewer");
  } catch (err) {
    toast(err.message);
    state.current = null;
    show("empty");
  }
  loadList();
}

function openEditor(note) {
  state.current = note;
  $("edit-title").value = note ? note.title : "";
  $("edit-content").value = note ? note.content : "";
  $("edit-preview").innerHTML = renderMarkdown($("edit-content").value);
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

function renderStatCards(summary) {
  const cards = [
    ["Notes", summary.notes],
    ["Total words", summary.words.toLocaleString()],
    ["Avg words / note", summary.avg_words.toLocaleString()],
    ["Total reading time", `${summary.reading_minutes} min`],
    ["Distinct tags", summary.tags],
  ];
  $("stat-cards").innerHTML = cards
    .map(
      ([label, value]) =>
        `<div class="stat-card"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
}

function renderActivity(activity) {
  const max = Math.max(1, ...activity.map((d) => d.count));
  $("activity-chart").innerHTML = activity
    .map((d) => {
      const day = new Date(d.date + "T00:00:00");
      const label = day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const tip = `${label}: ${d.count} note${d.count === 1 ? "" : "s"}`;
      const height = d.count ? Math.max(4, (d.count / max) * 100) : 0;
      return `
        <div class="activity-col" title="${tip}" aria-label="${tip}">
          <span class="activity-value">${d.count || ""}</span>
          <div class="activity-track"><div class="activity-bar" style="height:${height}%"></div></div>
          <span class="activity-label">${day.getDate()}</span>
        </div>`;
    })
    .join("");
}

function renderRankList(id, items, format) {
  const max = Math.max(1, ...items.map((i) => i.count));
  $(id).innerHTML = items.length
    ? items
        .map(
          (item) => `
          <li>
            <span class="rank-name">${escapeHtml(format(item))}</span>
            <span class="rank-bar"><span style="width:${(item.count / max) * 100}%"></span></span>
            <span class="rank-count">${item.count}</span>
          </li>`,
        )
        .join("")
    : `<li class="none">Nothing yet</li>`;
}

function renderNotesTable(notes) {
  $("notes-table").innerHTML = notes.length
    ? notes
        .map(
          (n) => `
          <tr>
            <td><a href="#/note/${encodeURIComponent(n.title)}">${escapeHtml(n.title)}</a></td>
            <td class="num">${n.words.toLocaleString()}</td>
            <td class="num">${n.reading_minutes} min</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="none">No notes yet — create one to see statistics.</td></tr>`;
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
    renderStatCards(stats.summary);
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

function route() {
  if (location.hash === "#/stats") {
    openStats();
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
$("report-close-btn").onclick = () => $("report-dialog").close();
$("save-btn").onclick = save;
$("cancel-btn").onclick = () =>
  state.current ? openNote(state.current.title) : show("empty");

$("edit-content").oninput = () => {
  $("edit-preview").innerHTML = renderMarkdown($("edit-content").value);
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
