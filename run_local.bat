@echo off
rem Start SimpleNotes locally. Double-click this file, then open http://localhost:8000
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv
)

echo Installing requirements...
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt

echo.
echo SimpleNotes is starting. Open http://localhost:8000 in your browser.
echo Close this window (or press Ctrl+C) to stop the app.
echo.
".venv\Scripts\python.exe" -m uvicorn app.main:app --reload --port 8000
pause
