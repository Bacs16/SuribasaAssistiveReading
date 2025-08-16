# Assistive Reading & Checking (Flask + HTML/CSS/JS)

Production-ready starter for an assistive reading app: live per-word highlighting, instant TTS correction,
and automatic ORF metrics (WCPM, Accuracy). Frontend is plain HTML/CSS/JS; backend is Flask + SQLite (SQLAlchemy).

## Quick Start

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

export FLASK_APP=app.py  # Windows: set FLASK_APP=app.py
flask run  # then open http://127.0.0.1:5000
```

**Seed data** (passages + wordbanks) load automatically on first run.

### Notes
- Browser ASR uses Web Speech API (`webkitSpeechRecognition`). Works best on Chrome.
- If you install `faster-whisper`, the `/api/asr` fallback endpoint can be used by the frontend when browser ASR is unavailable.
- Exports: CSV and PDF via endpoints on the Results page.

### File Tree

```
assistive-reading-flask/
├── app.py
├── models.py
├── services/
│   └── asr_whisper.py
├── templates/
│   ├── base.html
│   ├── dashboard.html
│   ├── passages.html
│   ├── read.html
│   └── results.html
├── static/
│   ├── css/app.css
│   └── js/
│       ├── utils.js
│       ├── ui.js
│       ├── record.js
│       ├── asr.js
│       ├── alignment.js
│       └── tts.js
├── seeds/wordbanks/grade4.json
├── seeds/wordbanks/grade5.json
├── seeds/wordbanks/grade6.json
├── requirements.txt
└── README.md
```

## Demo Flow
1. Go to **Passages** → Create or pick a sample passage.
2. Click **Start** on the Read page. You should see a blinking dot and VU bars.
3. Read aloud. Correct words turn **green**; misreads **red**; current word is outlined.
4. On misread, the app speaks the correct word (throttled).
5. Click **Stop** → metrics are computed and saved. Export CSV/PDF.

## ORF Metrics
- **WCPM** = (total words attempted − errors) / minutes
- **Accuracy** = correct / total

## Environment Variables (optional)
- `SECRET_KEY` for Flask sessions (defaults to dev key).
- `ASR_DEVICE` set to `cpu` or e.g. `cuda`. Defaults to `cpu`.

## License
MIT