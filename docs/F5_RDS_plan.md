# F5 数据库（RDS）实现说明 —— 给组员

> 目标：照 Lesson 8 的 Nimbus 做法，给 SimpleNotes 加一个**最简单**的数据库功能。老师说不用做得很 fancy。
> 写于 2026-10-24。代码里只用英文（注释、变量名、字符串），讨论可以用中文。

## 1. 要做成什么样（一句话）

**笔记文件继续存在 EBS；RDS 里放一张表，记录每篇笔记的元数据；Stats 页可以按标签或来源筛选，后台跑 SQL `SELECT`。**

和老师 Lesson 8 第 8–11 页一一对应：

| Nimbus（老师的例子） | SimpleNotes（我们） |
|---|---|
| 分析文件继续存在 EBS | 笔记 `.md` 文件继续存在 EBS，**不改** |
| RDS 存 ticker / analysis_type / date / filename | RDS 存 **title / tags / source / modified / filename** |
| 点 "Save analysis" → `INSERT` | 保存或导入笔记 → `INSERT`（改了先删旧行再插入，删笔记就删行） |
| 输入 ticker 点 "Show" → `SELECT` | 选标签或来源，点 **Show** → `SELECT ... WHERE` |

**不做**：CSV 导入导出、复杂多条件、界面大改。

## 2. 分工建议（三块，互不冲突）

| 部分 | 改哪些文件 | 谁 |
|---|---|---|
| A. 后端：数据库读写 | 新建 `app/db.py`，改 `app/main.py`，`requirements.txt` | |
| B. 前端：Stats 页的筛选框 | `app/static/index.html`、`app/static/app.js` | |
| C. 部署：YAML 加 RDS | `scripts/simplenotes.yaml`、`README.md` | |

每个人开自己的分支，做完提 Pull Request（和 Hongyu 之前一样）。A 先合并，B 依赖 A 的接口。

---

## 3. 表结构

一张表 `notes`：

| 字段 | 类型 | 例子 |
|---|---|---|
| `filename` | VARCHAR(255)，主键 | `Amazon S3.md` |
| `title` | VARCHAR(100) | `Amazon S3` |
| `tags` | VARCHAR(500)，逗号分隔 | `wikipedia,research` |
| `source` | VARCHAR(20) | `wikipedia` 或 `own` |
| `modified` | VARCHAR(10)，`YYYY-MM-DD` | `2026-10-18` |

展示时可以对应 slides 第 9 页说：这就是我们的 DB schema。

SQL 例子（展示时可以讲）：

```sql
SELECT title, tags, source, modified FROM notes WHERE source = 'wikipedia';
SELECT title, tags, source, modified FROM notes WHERE tags LIKE '%ds600%';
```

---

## 4. A. 后端

### 4.1 `requirements.txt` 加一行

```
pymysql==1.1.1
```

### 4.2 新建 `app/db.py`

本地开发**没有 RDS 也能跑**：没设置 `DB_HOST` 时自动用一个 SQLite 文件（`notes.db`），SQL 一样。到 AWS 上设置了 `DB_HOST` 就连 RDS（MySQL）。

```python
"""Note metadata in a SQL database: SQLite locally, Amazon RDS (MySQL) on AWS."""

import os
import sqlite3
from pathlib import Path

DB_HOST = os.environ.get("DB_HOST", "")
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# sqlite3 uses "?" placeholders, pymysql uses "%s"
P = "%s" if DB_HOST else "?"

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS notes (
    filename VARCHAR(255) PRIMARY KEY,
    title    VARCHAR(100),
    tags     VARCHAR(500),
    source   VARCHAR(20),
    modified VARCHAR(10)
)
"""


def connect():
    if DB_HOST:
        import pymysql

        return pymysql.connect(
            host=DB_HOST,
            user=os.environ.get("DB_USER", "admin"),
            password=os.environ.get("DB_PASSWORD", ""),
            database=os.environ.get("DB_NAME", "simplenotes"),
            connect_timeout=5,
        )
    return sqlite3.connect(PROJECT_ROOT / "notes.db")


def init_db():
    conn = connect()
    try:
        conn.cursor().execute(CREATE_TABLE)
        conn.commit()
    finally:
        conn.close()


def save_note_row(filename, title, tags, source, modified):
    """INSERT one row per note (delete the old row first, so saving twice is fine)."""
    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(f"DELETE FROM notes WHERE filename = {P}", (filename,))
        cur.execute(
            f"INSERT INTO notes (filename, title, tags, source, modified) "
            f"VALUES ({P}, {P}, {P}, {P}, {P})",
            (filename, title, ",".join(tags), source, modified),
        )
        conn.commit()
    finally:
        conn.close()


def delete_note_row(filename):
    conn = connect()
    try:
        conn.cursor().execute(f"DELETE FROM notes WHERE filename = {P}", (filename,))
        conn.commit()
    finally:
        conn.close()


def find_notes(tag="", source=""):
    """SELECT notes by tag and/or source. Returns the rows and the SQL that ran."""
    sql = "SELECT title, tags, source, modified FROM notes"
    conditions, params = [], []
    if tag:
        conditions.append(f"tags LIKE {P}")
        params.append(f"%{tag}%")
    if source:
        conditions.append(f"source = {P}")
        params.append(source)
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY modified DESC"
    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = [
            {"title": r[0], "tags": r[1], "source": r[2], "modified": r[3]}
            for r in cur.fetchall()
        ]
    finally:
        conn.close()
    return {"sql": sql, "params": params, "rows": rows}
```

为什么用 `{P}` 占位、把值放在 `params` 里，而不是直接拼字符串？**防 SQL 注入**。老师问到可以这么答。

### 4.3 改 `app/main.py`

**(1) 开头 import：**

```python
from datetime import date
from app import db
```

**(2) 加一个小函数**，把一篇笔记写进数据库（放在 Helpers 区）：

```python
def record_note(path: Path, content: str) -> None:
    """Keep the database row for this note in step with its file."""
    source = "wikipedia" if "#wikipedia" in content else "own"
    modified = date.fromtimestamp(path.stat().st_mtime).isoformat()
    db.save_note_row(path.name, path.stem, get_tags(content), source, modified)
```

**(3) 启动时建表，并把已有的笔记同步进数据库**（文件比数据库早，所以要补一次）：

```python
@app.on_event("startup")
def setup_database():
    db.init_db()
    for path, content in all_notes():
        record_note(path, content)
```

**(4) 在 4 个地方各加一行：**

| 函数 | 在哪加 | 加什么 |
|---|---|---|
| `create_note` | 写完文件之后、`return` 之前 | `record_note(path, note.content)` |
| `update_note` | 如果改了名（`old_path.rename(...)` 之后） | `db.delete_note_row(old_path.name)` |
| `update_note` | 写完文件之后、`return` 之前 | `record_note(new_path, note.content)` |
| `delete_note` | `path.unlink()` 之后 | `db.delete_note_row(path.name)` |
| `wiki_import` | 写完文件之后、`return` 之前 | `record_note(path, content)` |

**(5) 加一个查询接口**（放在 Analytics 或 API 区）：

```python
@app.get("/api/db/notes")
def db_find_notes(tag: str = "", source: str = ""):
    """Filter notes with a SQL query on the metadata table (F5)."""
    try:
        return db.find_notes(tag.strip().lower().lstrip("#"), source.strip())
    except Exception as err:
        raise HTTPException(503, f"Database error: {err}") from err
```

**(6) `.gitignore` 加一行**：`notes.db`（本地 SQLite 文件不要上传）。

### 4.4 自测（本地）

```
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

浏览器打开：
- `http://localhost:8000/api/db/notes` → 应该列出所有笔记
- `http://localhost:8000/api/db/notes?source=wikipedia` → 只有 Wikipedia 导入的
- `http://localhost:8000/api/db/notes?tag=ds600` → 只有带 `#ds600` 的

返回里有一个 `sql` 字段，就是实际跑的 SQL。

---

## 5. B. 前端：Stats 页加一个筛选框

### 5.1 `index.html`：在 Stats 页（`<section id="stats">`）最后、`Previous reports` 后面加：

```html
<section class="panel">
  <header class="panel-head"><h2>Find notes in the database</h2></header>
  <form id="db-form" class="reports-box">
    <input id="db-tag" placeholder="Tag, e.g. ds600" aria-label="Tag" />
    <select id="db-source" aria-label="Source">
      <option value="">Any source</option>
      <option value="own">Own notes</option>
      <option value="wikipedia">Wikipedia</option>
    </select>
    <button type="submit" class="primary">Show</button>
  </form>
  <pre id="db-sql" class="muted"></pre>
  <ul id="db-results"></ul>
</section>
```

### 5.2 `app.js`：加在其他事件绑定旁边

```javascript
$("db-form").onsubmit = async (e) => {
  e.preventDefault();
  const params = new URLSearchParams({ tag: $("db-tag").value, source: $("db-source").value });
  try {
    const result = await api("GET", `/api/db/notes?${params}`);
    $("db-sql").textContent = result.sql;
    $("db-results").innerHTML = result.rows.length
      ? result.rows
          .map(
            (r) =>
              `<li><a href="#/note/${encodeURIComponent(r.title)}">${escapeHtml(r.title)}</a> <small class="muted">${escapeHtml(r.source)} · ${escapeHtml(r.modified)} · ${escapeHtml(r.tags)}</small></li>`,
          )
          .join("")
      : `<li class="none">No notes match.</li>`;
  } catch (err) {
    toast(err.message);
  }
};
```

不用改 CSS，用现有样式就行。

---

## 6. C. 部署：在 `scripts/simplenotes.yaml` 加 RDS

和 Lesson 8 的 Lab 一样：**数据库放在私有子网，只允许 EC2 的安全组连 3306 端口**。我们模板里本来就有两个没用上的私有子网（两个可用区），正好给 RDS 用（RDS 的子网组要求至少两个可用区）。

### 6.1 `Parameters` 加一个密码参数

```yaml
  DBPassword:
    Type: String
    NoEcho: true
    MinLength: 8
    Description: Password for the RDS database (at least 8 characters)
```

### 6.2 `Resources` 加三个资源（放在 `WebSecurityGroup` 后面）

```yaml
  DBSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Allow MySQL only from the SimpleNotes web server
      VpcId: !Ref LabVPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 3306
          ToPort: 3306
          SourceSecurityGroupId: !Ref WebSecurityGroup

  DBSubnetGroup:
    Type: AWS::RDS::DBSubnetGroup
    Properties:
      DBSubnetGroupDescription: Private subnets for the SimpleNotes database
      SubnetIds:
        - !Ref PrivateSubnet1
        - !Ref PrivateSubnet2

  NotesDatabase:
    Type: AWS::RDS::DBInstance
    DeletionPolicy: Delete
    Properties:
      Engine: mysql
      DBInstanceClass: db.t3.micro
      AllocatedStorage: "20"
      DBName: simplenotes
      MasterUsername: admin
      MasterUserPassword: !Ref DBPassword
      DBSubnetGroupName: !Ref DBSubnetGroup
      VPCSecurityGroups:
        - !Ref DBSecurityGroup
      PubliclyAccessible: false
      MultiAZ: false
      BackupRetentionPeriod: 0
```

### 6.3 改 `WebServer1`

**(1)** `DependsOn` 加上数据库，让 EC2 等数据库建好再开机（这样 User Data 能拿到数据库地址）：

```yaml
    DependsOn:
      - PublicDefaultRoute
      - NotesDatabase
```

**(2)** User Data 里 systemd 服务那段，在 `Environment=APP_PASSWORD=...` 下面加 4 行：

```
          Environment=DB_HOST=${NotesDatabase.Endpoint.Address}
          Environment=DB_NAME=simplenotes
          Environment=DB_USER=admin
          Environment=DB_PASSWORD=${DBPassword}
```

（User Data 已经是 `!Sub`，所以 `${NotesDatabase.Endpoint.Address}` 会被换成真实地址。）

### 6.4 `Outputs` 可以加一个（方便展示时给老师看）

```yaml
  DatabaseEndpoint:
    Description: RDS endpoint (reachable only from the web server)
    Value: !GetAtt NotesDatabase.Endpoint.Address
```

### 6.5 部署时的变化
- 创建 stack 时 Parameters 页多一个 **DBPassword**，填一个至少 8 位的密码（不要用真实常用密码）。
- **RDS 创建要 10 分钟左右**，整个 stack 大概 15–20 分钟。展示当天提前建。
- **RDS 按小时收费，用完一定删 stack。**
- 如果 Learner Lab 报错说实例类型不允许，把 `db.t3.micro` 换成 Lab 里允许的类型（比如 `db.t4g.micro`）。

### 6.6 AWS 上验证
1. 打开 AppURL → Stats → 最下面的 "Find notes in the database"，选 Wikipedia → Show，应该显示 SQL 和结果。
2. 也可以直接访问 `http://<AppURL>/api/db/notes`。
3. 打不开就看 EC2 的 system log；数据库连不上通常是安全组或密码填错。

---

## 7. 展示时怎么讲（英文，可直接用）

> For F5 we followed the Nimbus pattern from Lesson 8. Note files stay on EBS, and an Amazon RDS MySQL database keeps one row of metadata per note: title, tags, source and date. Saving a note runs an INSERT, deleting runs a DELETE, and the "Find notes" box on the Stats page runs a SELECT with a WHERE clause, which we show on screen. RDS sits in the two private subnets of our VPC, and its security group only accepts port 3306 from the web server's security group, so the database is not reachable from the internet. RDS is created by the same CloudFormation template, and the app gets the database endpoint through User Data.

可能被问：
- **为什么不直接看文件？** 按标签、来源、日期筛选是对结构化数据的查询，数据库直接查元数据，不用打开每个文件；以后多台 EC2（F6）也能共用同一个数据库。
- **为什么放私有子网？** 数据库不需要被外网访问，只让 EC2 连，更安全（Module 4、5）。
- **密码怎么给 app？** CloudFormation 参数（NoEcho，不显示）→ User Data → systemd 环境变量。真实项目会用 Secrets Manager，课堂项目这样够用。

## 8. 完成清单

- [ ] A：`app/db.py` + `main.py` 5 处 + `requirements.txt` + `.gitignore`，本地自测通过
- [ ] B：Stats 页筛选框，本地点 Show 能看到 SQL 和结果
- [ ] C：YAML 加 RDS，在 Sandbox 建一次 stack 验证，用完删
- [ ] README 的 API 表加 `GET /api/db/notes`，Storage 一节加一句"metadata in RDS"
- [ ] 展示文档（Docs 里的 SimpleNotes on AWS）F5 一行改成 Done
