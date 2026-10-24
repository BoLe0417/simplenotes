"""Note metadata in a SQL database: SQLite locally, Amazon RDS (MySQL) on AWS."""

import os
import sqlite3
from pathlib import Path

DB_HOST = os.environ.get("DB_HOST", "")
PROJECT_ROOT = Path(__file__).resolve().parent.parent

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