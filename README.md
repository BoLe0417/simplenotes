# SimpleNotes

A simple Markdown note-taking web app, inspired by [flatnotes](https://github.com/dullage/flatnotes).
There is no database: every note is a plain `.md` file in a folder on disk.

Group project for **DS600 Cloud Computing for Economics** (SMU). The app is deployed on the
AWS Academy Sandbox.

## Features

- Create, view, edit, rename and delete notes
- Markdown editor with live preview
- Full-text search across titles and content (press `/` to jump to the search box)
- Tags: write `#tag` anywhere in a note, then click the tag in the sidebar to filter
- Links between notes: write `[[Another Note Title]]`
- **Note Analytics** (📊 Stats): number of notes, total / average words, reading time,
  an activity chart for the last 14 days, top tags, top words, and every note ranked by length
- **Saved reports**: click **Save Report** to save the current statistics as a Markdown file;
  pick one under **Previous Reports** and click **Show** to open it again
- Optional username / password login (HTTP Basic Auth)
- `Ctrl+S` to save; works in dark mode and on mobile screens

## Tech Stack

| Part     | Technology                                                                 |
| -------- | -------------------------------------------------------------------------- |
| Backend  | Python 3.10+, FastAPI, Uvicorn                                             |
| Frontend | Plain HTML / CSS / JavaScript (marked.js for Markdown, DOMPurify for safety) |
| Storage  | Markdown files on the local file system                                    |
| Hosting  | AWS EC2 (deployed with CloudFormation)                                     |

## Project Structure

```
simplenotes/
├── app/
│   ├── main.py          # Backend: API routes, file storage, analytics, optional login
│   └── static/          # Frontend: the web page the user sees
│       ├── index.html   # Page layout (sidebar, viewer, editor, stats page)
│       ├── app.js       # Page logic: calls the API and updates the page
│       └── style.css    # Styling
├── data/                # Notes are saved here (created automatically, not in Git)
├── reports/             # Saved analytics reports (created automatically, not in Git)
├── scripts/             # CloudFormation templates for AWS
├── requirements.txt     # Python packages
└── README.md
```

## Installation (run locally)

You need **Python 3.10 or newer** (the code uses the `str | None` syntax).
Check your version first:

```bash
python --version
```

**Step 1 — Get the code**

```bash
git clone https://github.com/<your-username>/simplenotes.git
cd simplenotes
```

**Step 2 — Create and activate a virtual environment**

Windows (PowerShell):

```powershell
python -m venv .venv
.\.venv\Scripts\activate
```

macOS / Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

**Step 3 — Install the packages**

```bash
pip install -r requirements.txt
```

**Step 4 — Start the app**

```bash
uvicorn app.main:app --reload --port 8080
```

**Step 5 — Open it**

Go to http://localhost:8080 in your browser. Create a note, then check that a new `.md` file
appears in the `data/` folder.

## Configuration (environment variables)

| Variable       | Default | Meaning                                              |
| -------------- | ------- | ---------------------------------------------------- |
| `NOTES_DIR`    | `data`  | Folder where notes are stored (relative to the project folder, wherever you start the app) |
| `REPORTS_DIR`  | `reports` | Folder where analytics reports are stored (relative to the project folder) |
| `APP_USERNAME` | `admin` | Login username                                       |
| `APP_PASSWORD` | (empty) | Login password. **If empty, no login is required.**  |

## API

| Method | Path                            | Description                                     |
| ------ | ------------------------------- | ----------------------------------------------- |
| GET    | `/api/notes?q=word&tag=name`    | List notes (optionally search / filter by tag)  |
| GET    | `/api/notes/{title}`            | Get one note                                    |
| POST   | `/api/notes`                    | Create a note: `{"title": "...", "content": "..."}` |
| PUT    | `/api/notes/{title}`            | Update or rename a note                         |
| DELETE | `/api/notes/{title}`            | Delete a note                                   |
| GET    | `/api/tags`                     | List all tags with counts                       |
| GET    | `/api/stats?tz_offset=480`      | Note analytics (`tz_offset` = minutes ahead of UTC, e.g. 480 for Singapore) |
| POST   | `/api/reports?tz_offset=480`    | Save the current analytics as a Markdown report |
| GET    | `/api/reports`                  | List saved reports, newest first                |
| GET    | `/api/reports/{name}`           | Get one saved report                            |
| GET    | `/health`                       | Health check (returns `{"status": "ok"}`)       |

Interactive API docs are available at `/docs` while the app is running.

## Code Walkthrough

The app has two halves that talk to each other over HTTP:

- **Frontend** (`app/static/`) — runs in the user's browser.
- **Backend** (`app/main.py`) — runs on the server (your laptop or the EC2 instance).

### Backend: `app/main.py`

| Section     | What it does                                                                 |
| ----------- | ---------------------------------------------------------------------------- |
| Settings    | Reads `NOTES_DIR`, `APP_USERNAME`, `APP_PASSWORD` and creates the notes folder |
| Auth        | `basic_auth` middleware: if a password is set, every request must log in    |
| Helpers     | `clean_title` blocks unsafe titles, `note_path` turns a title into a file path, `get_tags` finds `#tags`, `note_info` builds the summary shown in the list |
| Analytics   | `count_words` counts words (each Chinese character counts as one word), `reading_minutes` assumes 200 words per minute, `top_words` skips common words like "the", `build_stats` computes everything on the Stats page, `stats_to_markdown` turns it into a report |
| API         | One function per route in the API table above                               |
| Frontend    | `/` returns `index.html`; `/static/...` serves the CSS and JS files          |

### Frontend: `app/static/app.js`

| Function      | What it does                                                   |
| ------------- | -------------------------------------------------------------- |
| `api()`       | Sends a request to the backend and returns the JSON reply      |
| `loadList()`  | Fetches notes and tags, then draws the sidebar                 |
| `openNote()`  | Fetches one note and shows it, rendered as Markdown            |
| `openEditor()`| Shows the editor with live preview                             |
| `save()` / `remove()` | Create / update / delete a note                        |
| `openStats()` | Fetches `/api/stats` and draws the cards, chart, lists and table |
| `saveReport()` / `showReport()` | Saves a report / opens a saved report in a pop-up |
| `route()`     | Reads the URL (e.g. `#/note/Hello`, `#/stats`) to decide what to show |

### Example: what happens when you click "Save"

1. **Browser** — `save()` in `app.js` reads the title and content from the editor.
2. **Browser → Server** — it sends `POST /api/notes` (new note) or `PUT /api/notes/{title}`
   (existing note) with the data as JSON.
3. **Server** — FastAPI calls `create_note()` or `update_note()` in `main.py`.
   The data is checked by the `NoteIn` model, and `note_path()` turns the title into a safe
   file path such as `data/Hello.md`.
4. **Server** — the content is written to that `.md` file (`path.write_text(...)`).
   If the title changed, the old file is renamed first.
5. **Server → Browser** — the server replies with the saved note. The browser shows a
   "Saved" message, opens the note and refreshes the sidebar list.

Reading, searching and deleting follow the same pattern: browser → API route → file on disk → reply.

## Storage: where the data lives

Notes and reports are plain Markdown files. The same code works locally and on AWS,
with no environment-specific setup:

| Where | Notes | Reports | Storage |
| ----- | ----- | ------- | ------- |
| Your laptop | `simplenotes/data/` | `simplenotes/reports/` | Local disk |
| EC2 | `/opt/simplenotes/data/` | `/opt/simplenotes/reports/` | The instance's **EBS** root volume |

**Verify on your laptop:** open 📊 Stats, click **Save Report**, then check that a new
`notes-report-YYYY-MM-DD_HHMMSS.md` file appears in `reports/`.

**Verify on EC2:** connect to the instance (EC2 → `SimpleNotes Server` → Connect →
EC2 Instance Connect), then run:

```bash
df -h /                          # the EBS root volume and its free space
ls -l /opt/simplenotes/data      # one .md file per note
ls -l /opt/simplenotes/reports   # one .md file per saved report
cat /opt/simplenotes/reports/<file name>.md
```

Because the files are on the instance's EBS volume, **they are deleted together with the stack.**
Moving them to Amazon S3 would keep them after the stack is deleted.

## Deploy to AWS (CloudFormation)

The app is deployed to the AWS Academy Sandbox with **Infrastructure as Code**:
one CloudFormation template builds the whole environment, so it can be recreated
the same way in every sandbox session.

| File | Purpose |
| ---- | ------- |
| `scripts/lesson5.yaml` | Lab 2 environment (VPC + sample web app on port 80). Used to test the network setup. |
| `scripts/simplenotes.yaml` | Same network, but the EC2 instance installs and runs SimpleNotes on port 8080. |

**What `simplenotes.yaml` creates**

- VPC `10.0.0.0/16` with 2 public and 2 private subnets in two Availability Zones
- Internet Gateway, NAT Gateway and route tables
- Security group allowing inbound TCP **8080**
- One `t2.micro` EC2 instance (Amazon Linux 2023) in a public subnet, using the sandbox's
  `LabInstanceProfile` (LabRole) so it can call AWS services without hard-coded keys. Its user data:
  1. installs Git and Python 3.11
  2. clones this repository
  3. creates a virtual environment and runs `pip install -r requirements.txt`
  4. starts the app as a systemd service on `0.0.0.0:8080`, so it also restarts automatically when the instance reboots

**Steps**

1. Start the Learner Lab and open the AWS Console (region **us-east-1**).
2. Go to **CloudFormation → Create stack → With new resources → Upload a template file**
   and choose `scripts/simplenotes.yaml`.
3. Stack name: `simplenotes`. Keep the default parameters (`RepoUrl` points to this repo;
   `AppPassword` is optional — if set, log in as `admin`).
4. Wait for `CREATE_COMPLETE`, then wait another 3–5 minutes while the instance installs the app.
5. Open the **Outputs** tab and click **AppURL** (`http://...:8080` — use http, not https).

**Troubleshooting:** EC2 → select `SimpleNotes Server` → Actions → Monitor and troubleshoot →
**Get system log** shows every step of the user data script.

**Cost warning:** the NAT Gateway is billed every hour it exists. **Delete the stack at the end
of every session.** Notes are stored on the instance disk, so they are deleted with the stack.

## Credits

Inspired by [flatnotes](https://github.com/dullage/flatnotes) by Dullage.
