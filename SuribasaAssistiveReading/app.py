import os
import io
import csv
import json
import uuid
import time
from datetime import datetime
from functools import wraps
from typing import Optional

from flask import (
    Flask, render_template, request, redirect, url_for, jsonify,
    send_file, flash, session
)
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash, generate_password_hash

from models import db, Passage, Session, WordEvent, seed_initial_data, User, Profile
from services.asr_whisper import transcribe_blob_or_501
from services.asr_vosk import transcribe_blob_vosk_or_none, _load_model
from io import BytesIO
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

# ---------------------------------------------------------------------
# Optional: load .env (GOOGLE_API_KEY/GEMINI_API_KEY, SECRET_KEY, etc.)
# ---------------------------------------------------------------------
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# ===================== Gemini (google-genai, NEW SDK) ======================
#   pip install google-genai
#   env: GOOGLE_API_KEY (or GEMINI_API_KEY)
try:
    from google import genai
    from google.genai import types
except Exception as _imp_err:  # pragma: no cover
    genai = None
    types = None

GEMINI_API_KEY = (os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or "").strip()
GEMINI_MODEL = (os.getenv("GEMINI_MODEL") or "gemini-2.0-flash-001").strip()

_client = None
if genai and GEMINI_API_KEY:
    try:
        _client = genai.Client(api_key=GEMINI_API_KEY)
    except Exception as _init_err:  # pragma: no cover
        _client = None


def _gemini_enabled() -> bool:
    return bool(_client and GEMINI_API_KEY and genai and types)
# ==========================================================================


# ----------------- Small helpers: auth + words/tokenizer -----------------
def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("login", next=request.path))
        return fn(*args, **kwargs)
    return wrapper


def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    return User.query.get(uid)


def count_words_no_punct(text: str) -> int:
    tokens = tokenize_for_display(text or "")
    import re as _re
    return sum(1 for t in tokens if _re.fullmatch(r"[A-Za-z']+|[0-9]+", t))


def fmt_mmss(sec: float) -> str:
    sec = max(0, int(round(sec or 0)))
    m, s = divmod(sec, 60)
    return f"{m:d}:{s:02d}"


def tokenize_for_display(text):
    """Split words and punctuation; UI ignores punctuation for scoring."""
    import re
    tokens = re.findall(r"""[A-Za-z']+|[0-9]+|\S""", text or "")
    return tokens


# ----------------- Comprehension helpers -----------------
def _simple_tokens(text):
    import re
    return re.findall(r"[A-Za-z']+|[0-9]+", text or "")


def _sentences(text):
    import re
    parts = re.split(r'(?<=[.!?])\s+', (text or "").strip())
    return [p.strip() for p in parts if p.strip()]


def _key_terms(text, k=20):
    from collections import Counter
    toks = [t.lower() for t in _simple_tokens(text)]
    STOP = set(["a", "an", "the", "to", "of", "in", "c", "on", "at", "by", "for", "and", "or", "as",
                "is", "are", "was", "were", "be", "being", "been", "with", "from", "into", "over",
                "after", "before", "during", "without", "within", "that", "this", "those", "these",
                "it", "its", "he", "she", "they", "we", "you", "i", "his", "her", "their", "our",
                "your", "not"])
    toks = [t for t in toks if t not in STOP and len(t) > 2]
    freq = Counter(toks)
    return [w for w, _ in freq.most_common(k)]


def generate_questions_from_passage(text, n=10):
    """Local basic generator (fallback if ever used)."""
    import re
    sents = _sentences(text)
    terms = _key_terms(text, k=30)
    qs = []
    ci = 0
    for term in terms:
        cand = next((s for s in sents if term.lower() in s.lower()), None)
        if not cand:
            continue
        blanked = re.sub(r'\b' + re.escape(term) + r'\b', '_____', cand, flags=re.IGNORECASE)
        if blanked != cand:
            qs.append({"id": f"cloze_{ci}", "type": "cloze", "prompt": blanked, "answer": term})
            ci += 1
        if len(qs) >= max(1, n // 2):
            break
    starters = ["What happens", "Who is involved", "Where does it happen", "Why does it happen",
                "When does it occur", "What is the main idea"]
    j = 0
    for s in sents:
        stem = starters[j % len(starters)]
        prompt = f'{stem} in this part: "{s}"?'
        answer = next((t for t in terms if t in s.lower()), s)
        qs.append({"id": f"wh_{j}", "type": "wh", "prompt": prompt, "answer": answer})
        j += 1
        if len(qs) >= n:
            break
    return qs[:n]


# ----------------- Accent helpers (Filipino-friendly) -----------------
def _accent_mode_from_request(req):
    env_default = (os.getenv("ASR_ACCENT") or "").strip().lower()
    q = (req.form.get("accent") or req.args.get("accent") or env_default or "").strip().lower()
    if q in {"fil", "filipino", "ph", "tl"}:
        return "fil"
    return None


def _expand_filipino_variants(words):
    if not words:
        return words
    import re

    out = set()

    def add(s):
        s = (s or "").strip()
        if s:
            out.add(s)

    for w in words:
        if not w:
            continue
        add(w)  # original
        lw = w.lower()

        cand = set()
        cand.add(re.sub(r'th', 't', lw))
        cand.add(re.sub(r'th', 'd', lw))
        cand.add(re.sub(r'ph', 'p', lw))
        cand.add(re.sub(r'ph', 'f', lw))
        cand.add(re.sub(r'sh', 's', lw))
        cand.add(re.sub(r'ch', 's', lw))
        cand.add(re.sub(r'qu', 'k', lw))
        cand.add(re.sub(r'x', 'ks', lw))
        cand.add(re.sub(r'c(?=[eiy])', 's', lw))
        cand.add(re.sub(r'c', 'k', lw))
        cand.add(re.sub(r'v', 'b', lw))
        cand.add(re.sub(r'f', 'p', lw))
        cand.add(re.sub(r'z', 's', lw))

        if 'i' in lw and len(lw) >= 4 and lw.isalpha():
            cand.add(lw.replace('i', 'e', 1))
        if 'e' in lw and len(lw) >= 4 and lw.isalpha():
            cand.add(lw.replace('e', 'i', 1))

        for v in cand:
            if v and v != lw:
                add(v)

    MAX = 1500
    if len(out) > MAX:
        out = set(list(out)[:MAX])
    return list(out)


# ----------------- JSON cleaning for model outputs -----------------
def _clean_json_like(s: str) -> str:
    import re
    s = (s or "").strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.I | re.M)
    s = re.sub(r"(?m)^\s*//.*$", "", s)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r",\s*([}\]])", r"\1", s)
    return s.strip()


def _extract_json_like(s: str):
    if not s:
        return None
    s = _clean_json_like(s)
    try:
        return json.loads(s)
    except Exception:
        pass
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        chunk = _clean_json_like(s[start:end+1])
        try:
            return json.loads(chunk)
        except Exception:
            return None
    return None


# ----------------- MCQ normalization + Gemini generator -----------------
def _normalize_mcq_strict(payload, want=10, options_n=4, cognitive=None):
    cognitive = cognitive or ["analyze", "infer", "evaluate", "interpret"]
    qs = payload.get("questions") if isinstance(payload, dict) else payload
    if not isinstance(qs, list):
        return []

    out = []
    for q in qs:
        opts = [str(o).strip() for o in (q.get("options") or []) if str(o).strip()]
        if len(opts) != options_n:
            continue
        ai = q.get("answer_index")
        if not isinstance(ai, int) or not (0 <= ai < options_n):
            continue

        out.append({
            "id": str(q.get("id") or uuid.uuid4().hex),
            "type": "mcq_hots",
            "prompt": str(q.get("prompt") or q.get("question") or "").strip(),
            "options": opts[:options_n],
            "answer_index": int(ai),
            "rationale": str(q.get("rationale") or "").strip(),
            "cognitive_process": str(q.get("cognitive_process") or cognitive[0])
        })
        if len(out) >= want:
            break
    return out


def _generate_hots_mcqs_gemini(text: str, count=10, options_n=4, cognitive=None):
    if not _gemini_enabled():
        raise RuntimeError("Gemini not configured. Set GOOGLE_API_KEY or GEMINI_API_KEY.")
    cognitive = cognitive or ["analyze", "infer", "evaluate", "interpret"]

    passage = (text or "").strip()
    if len(passage) > 9000:
        passage = passage[:9000] + "…"

    system = (
        "You are an expert reading-assessment item writer. "
        "Write higher-order MCQs that require analysis, inference, evaluation, or interpretation. "
        "Avoid recall and cloze. Each item MUST have exactly 4 plausible, distinct options and one correct answer."
    )

    def _prompt(n):
        return (
            f"{system}\n\nPASSAGE:\n{passage}\n\n"
            f"Create {n} MCQs with exactly {options_n} options each.\n"
            f"Target processes: {', '.join(cognitive)}.\n"
            "Return ONLY JSON with this shape:\n"
            "{ \"questions\": [ {"
            "  \"id\": string, "
            "  \"prompt\": string, "
            f"  \"options\": array[{options_n}] of string, "
            "  \"answer_index\": integer (0-based), "
            "  \"rationale\": string, "
            f"  \"cognitive_process\": one of " + json.dumps(cognitive) +
            "} ] }"
        )

    collected = []
    attempts = 0
    need = int(count)

    while len(collected) < count and attempts < 6:
        attempts += 1
        response_text = None
        error_detail = None
        try:
            resp = _client.models.generate_content(
                model=GEMINI_MODEL,
                contents=_prompt(need),
                config=types.GenerateContentConfig(
                    temperature=0.3,
                    response_mime_type="application/json",
                ),
            )
            response_text = resp.text
        except Exception as e:
            error_detail = str(e)

        if not response_text:
            try:
                resp = _client.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=_prompt(need),
                    config=types.GenerateContentConfig(temperature=0.3),
                )
                response_text = resp.text
            except Exception as e:
                error_detail = str(e)

        if not response_text:
            break

        data = _extract_json_like(response_text) or {}
        batch = _normalize_mcq_strict(data, want=need, options_n=options_n, cognitive=cognitive)

        seen = {q["prompt"] for q in collected}
        for q in batch:
            if q["prompt"] not in seen:
                collected.append(q)
                seen.add(q["prompt"])

        need = count - len(collected)
        if not batch and error_detail:
            time.sleep(0.4)

    return collected[:count]


# ----------------- App factory -----------------
def create_app():
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key')
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///app.db'
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

    # Profile avatar uploads
    app.config['UPLOAD_FOLDER'] = os.path.join(app.root_path, 'static', 'uploads')
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    ALLOWED_IMG = {'png', 'jpg', 'jpeg', 'webp'}

    db.init_app(app)

    with app.app_context():
        db.create_all()
        seed_initial_data()

    # ------- utilities -------
    def save_avatar(file_storage, user_id) -> Optional[str]:
        """Save an uploaded avatar into /static/uploads and return the *relative* path."""
        if not file_storage or not file_storage.filename:
            return None
        _, ext = os.path.splitext(file_storage.filename)
        ext = (ext or "").lower().lstrip(".")
        if ext not in ALLOWED_IMG:
            return None
        fname = secure_filename(f"user{user_id}_{int(datetime.utcnow().timestamp())}.{ext}")
        abs_path = os.path.join(app.config['UPLOAD_FOLDER'], fname)
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        file_storage.save(abs_path)
        return f"uploads/{fname}"

    # Jinja helpers
    @app.context_processor
    def inject_globals():
        return {
            "current_year": datetime.utcnow().year,
            "current_user": current_user(),
            "is_authenticated": bool(session.get("user_id")),
        }

    # -----------------------------
    # SIGN UP
    # -----------------------------
    @app.route('/signup', methods=['GET', 'POST'])
    def signup():
        if session.get('user_id'):
            u = User.query.get(session['user_id'])
            return redirect(url_for('dashboard') if (u and u.profile) else url_for('account'))

        if request.method == 'POST':
            email = (request.form.get('email') or '').strip().lower()
            password = request.form.get('password') or ''
            confirm = request.form.get('confirm') or ''

            if not email or not password:
                flash('Email and password are required.', 'danger')
                return render_template('signup.html'), 400
            if len(password) < 6:
                flash('Password must be at least 6 characters.', 'danger')
                return render_template('signup.html'), 400
            if password != confirm:
                flash('Passwords do not match.', 'danger')
                return render_template('signup.html'), 400
            if User.query.filter_by(email=email).first():
                flash('An account with that email already exists. Try signing in.', 'danger')
                return render_template('signup.html'), 400

            user = User(email=email, password_hash=generate_password_hash(password))
            db.session.add(user)
            db.session.flush()

            prof = Profile(
                user_id=user.id,
                teacher_name=(request.form.get('teacher_name') or '').strip() or None,
                grade=(request.form.get('grade') or '').strip() or None,
                section=(request.form.get('section') or '').strip() or None,
                school_id=(request.form.get('school_id') or '').strip() or None,
                school=(request.form.get('school') or '').strip() or None,
                screening_level=(request.form.get('screening_level') or '').strip() or None,
                subject=(request.form.get('subject') or '').strip() or None,
                school_year=(request.form.get('school_year') or '').strip() or None
            )
            try:
                prof.total_enrolment = int(request.form.get('total_enrolment') or 0)
            except Exception:
                prof.total_enrolment = 0

            avatar_rel = save_avatar(request.files.get('avatar'), user.id)
            if avatar_rel and hasattr(prof, "avatar_path"):
                prof.avatar_path = avatar_rel

            db.session.add(prof)
            db.session.commit()

            session['user_id'] = user.id
            flash('Welcome! Your account is ready.', 'success')
            return redirect(url_for('dashboard'))

        return render_template('signup.html')

    # -----------------------------
    # Login → Dashboard
    # -----------------------------
    @app.route('/login', methods=['GET', 'POST'])
    def login():
        if request.method == 'POST':
            email = (request.form.get('email') or '').strip().lower()
            password = request.form.get('password') or ''
            user = User.query.filter_by(email=email).first()
            if not user or not check_password_hash(user.password_hash, password):
                flash('Invalid email or password.', 'danger')
                return render_template('login.html'), 401

            session['user_id'] = user.id
            nxt = request.args.get('next')
            if user.profile:
                return redirect(nxt or url_for('dashboard'))
            return redirect(url_for('account'))

        if session.get('user_id'):
            u = User.query.get(session['user_id'])
            return redirect(url_for('dashboard') if (u and u.profile) else url_for('account'))
        return render_template('login.html')

    @app.route('/logout')
    def logout():
        session.pop('user_id', None)
        flash('You have been logged out.', 'info')
        return redirect(url_for('login'))

    # -----------------------------
    # Account (profile)
    # -----------------------------
    @app.route('/account', methods=['GET', 'POST'])
    @login_required
    def account():
        user = current_user()
        prof = Profile.query.filter_by(user_id=user.id).first()
        if request.method == 'POST':
            if not prof:
                prof = Profile(user_id=user.id)
                db.session.add(prof)

            prof.teacher_name = (request.form.get('teacher_name') or '').strip() or None
            prof.grade = (request.form.get('grade') or '').strip() or None
            prof.section = (request.form.get('section') or '').strip() or None
            prof.school_id = (request.form.get('school_id') or '').strip() or None
            prof.school = (request.form.get('school') or '').strip() or None
            prof.screening_level = (request.form.get('screening_level') or '').strip() or None
            try:
                prof.total_enrolment = int(request.form.get('total_enrolment') or 0)
            except Exception:
                prof.total_enrolment = 0
            prof.school_head = (request.form.get('school_head') or '').strip() or None
            prof.subject = (request.form.get('subject') or '').strip() or None
            prof.school_year = (request.form.get('school_year') or '').strip() or None

            avatar_rel = save_avatar(request.files.get('avatar'), user.id)
            if avatar_rel and hasattr(prof, "avatar_path"):
                prof.avatar_path = avatar_rel

            db.session.commit()
            flash('Profile saved.', 'success')
            return redirect(url_for('dashboard'))

        return render_template('account.html', profile=prof, user=user)

    # -----------------------------
    # Root → Dashboard
    # -----------------------------
    @app.route('/')
    def dashboard():
        if not session.get('user_id'):
            return redirect(url_for('login'))
        passages = Passage.query.order_by(Passage.created_at.desc()).all()
        sessions = Session.query.order_by(Session.started_at.desc()).limit(10).all()
        return render_template('dashboard.html', passages=passages, sessions=sessions)

    # -----------------------------
    # Passages CRUD
    # -----------------------------
    @app.route('/passages', methods=['GET', 'POST'])
    @login_required
    def passages():
        if request.method == 'POST':
            title = (request.form.get('title') or 'Untitled').strip() or 'Untitled'
            grade_level = (request.form.get('grade_level') or 'N/A').strip() or 'N/A'
            text = (request.form.get('text') or '').strip()
            if request.files.get('file'):
                f = request.files['file']
                _ = secure_filename(f.filename)
                text = f.read().decode('utf-8', errors='ignore')
            p = Passage(title=title, text=text, grade_level=grade_level)
            db.session.add(p)
            db.session.commit()
            flash('Passage created.', 'success')
            return redirect(url_for('passages'))

        items = Passage.query.order_by(Passage.created_at.desc()).all()
        return render_template('passages.html', passages=items)

    @app.route('/passages/<int:pid>')
    @login_required
    def passage_view(pid):
        p = Passage.query.get_or_404(pid)
        tokens = tokenize_for_display(p.text)
        return render_template('read.html', passage=p, tokens=tokens)

    @app.route('/read')
    @login_required
    def read_query():
        pid = request.args.get('passage_id', type=int)
        if not pid:
            return redirect(url_for('passages'))
        return redirect(url_for('passage_view', pid=pid))

    @app.route('/passages/<int:pid>/edit', methods=['GET', 'POST'])
    @login_required
    def passage_edit(pid):
        p = Passage.query.get_or_404(pid)
        if request.method == 'POST':
            p.title = request.form.get('title', p.title)
            p.grade_level = request.form.get('grade_level', p.grade_level)
            if request.form.get('text') is not None:
                p.text = request.form.get('text')
            db.session.commit()
            flash('Passage updated.', 'success')
            return redirect(url_for('passages'))
        return render_template('passage_edit.html', passage=p)

    @app.route('/passages/<int:pid>/delete', methods=['POST'])
    @login_required
    def passage_delete(pid):
        p = Passage.query.get_or_404(pid)
        db.session.delete(p)
        db.session.commit()
        if request.headers.get('X-Requested-With') == 'fetch':
            return jsonify({'ok': True})
        flash('Passage deleted.', 'info')
        return redirect(url_for('passages'))

    @app.route('/api/passages/<int:pid>')
    @login_required
    def api_passage(pid):
        p = Passage.query.get_or_404(pid)
        return jsonify({'id': p.id, 'title': p.title, 'grade_level': p.grade_level, 'text': p.text})

    # -----------------------------
    # RESULTS + derived metrics
    # -----------------------------
    def _comp_details_for_session(s: Session):
        """Return (pct, correct, total) using answered-only denominator."""
        correct = total = None
        if hasattr(Session, 'comprehension_correct') and hasattr(Session, 'comprehension_total'):
            correct, total = s.comprehension_correct, s.comprehension_total
        else:
            try:
                e = json.loads(s.errors_json or '{}')
                comp = e.get('comprehension') or {}
                correct, total = comp.get('correct'), comp.get('total')
            except Exception:
                correct = total = None
        try:
            correct = int(correct)
            total = int(total)
            if total > 0:
                pct = round(correct / total * 100.0, 1)
            else:
                pct = None
        except Exception:
            pct = None
        return pct, correct, total

    def _comp_level_from_pct(pct: Optional[float]) -> Optional[str]:
        if pct is None:
            return None
        if pct <= 59:
            return "FRUSTRATION"
        if pct <= 79:
            return "INSTRUCTIONAL"
        return "INDEPENDENT"

    def _word_reading_score(words_total: int, total_miscues: int) -> Optional[int]:
        """Score = (correct words / total words)*100 rounded, clamped 0..100."""
        if not words_total:
            return None
        correct_words = max(0, words_total - total_miscues)
        pct = round((correct_words / float(words_total)) * 100.0)
        return max(0, min(100, int(pct)))

    def _word_level_from_score(score: Optional[int]) -> Optional[str]:
        if score is None:
            return None
        if score >= 97:
            return "INDEPENDENT"
        if score >= 90:
            return "INSTRUCTIONAL"
        return "FRUSTRATION"

    def _reading_profile(comp_level: Optional[str], wr_level: Optional[str]) -> Optional[str]:
        if not comp_level and not wr_level:
            return None
        if comp_level == "FRUSTRATION" or wr_level == "FRUSTRATION":
            return "FRUSTRATION"
        if comp_level == "INDEPENDENT" and wr_level == "INDEPENDENT":
            return "INDEPENDENT"
        return "INSTRUCTIONAL"

    @app.route('/results')
    @login_required
    def results():
        sessions = Session.query.order_by(Session.started_at.desc()).all()
        rows = []
        for s in sessions:
            p = Passage.query.get(s.passage_id) if s.passage_id else None
            words_total = count_words_no_punct(p.text) if p else 0

            # miscues
            try:
                errs = json.loads(s.errors_json or '{}')
            except Exception:
                errs = {}
            mispron = int(errs.get("mispronunciations", 0))
            omiss   = int(errs.get("omissions", 0))
            subst   = int(errs.get("substitutions", 0))
            insert  = int(errs.get("insertions", 0))
            repeat  = int(errs.get("repetitions", 0))
            transpo = int(errs.get("transpositions", 0))
            rev     = int(errs.get("reversals", 0))
            total_miscues = mispron + omiss + subst + insert + repeat + transpo + rev

            # comprehension
            comp_pct, comp_correct, comp_total = _comp_details_for_session(s)
            comp_level = _comp_level_from_pct(comp_pct)

            # word reading metrics
            wr_score = _word_reading_score(words_total, total_miscues)
            wr_level = _word_level_from_score(wr_score)

            # combined profile
            profile = _reading_profile(comp_level, wr_level)

            # display name using new fields, fallback to legacy
            try:
                display_name = s.student_display_name  # property from models.py
            except Exception:
                mi = (getattr(s, "middle_initial", "") or "").strip().rstrip(".")
                mi_part = f" {mi}." if mi else ""
                if getattr(s, "surname", None) or getattr(s, "first_name", None):
                    display_name = f"{(s.surname or '').strip()}, {(s.first_name or '').strip()}{mi_part}".strip(", ")
                else:
                    display_name = s.student_name or "—"

            rows.append({
                "id": s.id,
                "student_name": display_name,            # keep key name for existing templates
                "surname": getattr(s, "surname", None),
                "first_name": getattr(s, "first_name", None),
                "middle_initial": getattr(s, "middle_initial", None),
                "grade_level": getattr(s, "grade_level", None),

                "words": words_total,
                "time_sec": round(float(s.duration_sec or 0), 1),
                "wpm": round(float(s.wcpm or 0), 1),
                "accuracy": round(float(s.accuracy or 0), 1),

                # comprehension
                "comp_pct": comp_pct,
                "comp_correct": comp_correct,
                "comp_total": comp_total,
                "comp_level": comp_level,

                # miscues
                "mispronunciations": mispron,
                "omissions": omiss,
                "substitutions": subst,
                "insertions": insert,
                "repetitions": repeat,
                "transpositions": transpo,
                "reversals": rev,

                # derived
                "word_score": wr_score,
                "word_level": wr_level,
                "reading_profile": profile,

                # links
                "csv_url": url_for('export_csv', sid=s.id),
                "pdf_url": url_for('report_pdf', sid=s.id),
                "del_url": url_for('session_delete', sid=s.id),
            })
        return render_template('results.html', rows=rows)

    # -----------------------------
    # Save a session  (REQUIRES learner fields)
    # -----------------------------
    @app.route('/api/sessions', methods=['POST'])
    @login_required
    def api_sessions():
        data = request.get_json(force=True) or {}

        # NEW: enforce required learner identity fields
        required = ["surname", "first_name", "middle_initial", "grade_level"]
        missing = [k for k in required if not str(data.get(k, "")).strip()]
        if missing:
            return jsonify({"ok": False, "error": f"Missing: {', '.join(missing)}"}), 400

        # Build display for legacy column (optional)
        mi = str(data.get("middle_initial", "")).strip().rstrip(".")
        mi_part = f" {mi}." if mi else ""
        legacy_name = f"{data.get('surname','').strip()}, {data.get('first_name','').strip()}{mi_part}".strip(", ")

        s = Session(
            passage_id=data.get('passage_id'),
            # NEW learner fields
            surname=str(data.get('surname', '')).strip(),
            first_name=str(data.get('first_name', '')).strip(),
            middle_initial=str(data.get('middle_initial', '')).strip(),
            grade_level=str(data.get('grade_level', '')).strip(),

            # Legacy fill (kept for older templates/exports)
            student_name=legacy_name or None,

            started_at=datetime.fromtimestamp(data.get('started_at', datetime.utcnow().timestamp())),
            duration_sec=float(data.get('duration_sec', 0)),
            wcpm=float(data.get('wcpm', 0)),
            accuracy=float(data.get('accuracy', 0)),
            errors_json=json.dumps(data.get('errors', {}) or {})
        )
        db.session.add(s)
        db.session.flush()
        for we in data.get('word_events', []):
            db.session.add(WordEvent(
                session_id=s.id,
                word_index=we.get('word_index', 0),
                status=we.get('status', 'unknown'),
                start_ms=we.get('start_ms'),
                end_ms=we.get('end_ms'),
                asr_text=we.get('asr_text', ''),
                confidence=we.get('confidence', 0.0),
            ))
        db.session.commit()
        return jsonify({'ok': True, 'id': s.id})

    @app.route('/api/sessions/<int:sid>/delete', methods=['POST'])
    @login_required
    def session_delete(sid):
        s = Session.query.get_or_404(sid)
        WordEvent.query.filter_by(session_id=sid).delete()
        db.session.delete(s)
        db.session.commit()
        return jsonify({'ok': True})

    # -----------------------------
    # Export CSV / PDF
    # -----------------------------
    @app.route('/api/sessions/<int:sid>/export.csv')
    @login_required
    def export_csv(sid):
        _ = Session.query.get_or_404(sid)
        we = WordEvent.query.filter_by(session_id=sid).order_by(WordEvent.word_index.asc()).all()
        sio = io.StringIO(newline="")
        writer = csv.writer(sio)
        writer.writerow(["word_index", "status", "start_ms", "end_ms", "asr_text", "confidence"])
        for e in we:
            writer.writerow([
                e.word_index,
                e.status,
                e.start_ms or "",
                e.end_ms or "",
                (e.asr_text or ""),
                e.confidence or 0
            ])
        data = sio.getvalue().encode("utf-8")
        return send_file(BytesIO(data), mimetype="text/csv", as_attachment=True,
                         download_name=f"session_{sid}.csv")

    @app.route('/api/sessions/<int:sid>/report.pdf')
    @login_required
    def report_pdf(sid):
        s = Session.query.get_or_404(sid)
        p = Passage.query.get(s.passage_id) if s.passage_id else None
        words_total = count_words_no_punct(p.text) if p else 0
        try:
            errors = json.loads(s.errors_json or '{}')
        except Exception:
            errors = {}

        # display name using new fields, fallback
        try:
            display_name = s.student_display_name
        except Exception:
            mi = (getattr(s, "middle_initial", "") or "").strip().rstrip(".")
            mi_part = f" {mi}." if mi else ""
            if getattr(s, "surname", None) or getattr(s, "first_name", None):
                display_name = f"{(s.surname or '').strip()}, {(s.first_name or '').strip()}{mi_part}".strip(", ")
            else:
                display_name = s.student_name or "—"

        buffer = BytesIO()
        c = canvas.Canvas(buffer, pagesize=letter)
        width, height = letter

        y = height - 50
        c.setFont("Helvetica-Bold", 18)
        c.drawString(50, y, "Reading Session Report"); y -= 28

        c.setFont("Helvetica", 12)
        c.drawString(50, y, f"Student: {display_name}"); y -= 18
        c.drawString(50, y, f"Grade Level: {getattr(s, 'grade_level', '') or '—'}"); y -= 18
        c.drawString(50, y, f"Words: {words_total}"); y -= 18
        c.drawString(50, y, f"Time: {fmt_mmss(s.duration_sec)}"); y -= 28

        c.setFont("Helvetica-Bold", 13)
        c.drawString(50, y, "Miscues (Frequency)"); y -= 20

        c.setFont("Helvetica", 12)
        line_gap = 16
        fields = [
            ("Mispronunciations", int(errors.get("mispronunciations", 0))),
            ("Omissions", int(errors.get("omissions", 0))),
            ("Substitutions", int(errors.get("substitutions", 0))),
            ("Insertions", int(errors.get("insertions", 0))),
            ("Repetitions", int(errors.get("repetitions", 0))),
            ("Transpositions", int(errors.get("transpositions", 0))),
            ("Reversals", int(errors.get("reversals", 0))),
        ]
        for label, val in fields:
            c.drawString(60, y, f"{label}: {val}")
            y -= line_gap

        c.showPage()
        c.save()
        buffer.seek(0)
        return send_file(buffer, mimetype='application/pdf', as_attachment=True,
                         download_name=f'session_{sid}.pdf')

    # -----------------------------
    # ASR status + API
    # -----------------------------
    @app.route('/api/asr/status')
    @login_required
    def asr_status():
        m = _load_model()
        return jsonify({
            "vosk_model_path": os.getenv("VOSK_MODEL"),
            "vosk_loaded": bool(m),
            "default_lang": (os.getenv("ASR_LANG") or "en"),
            "default_accent": (os.getenv("ASR_ACCENT") or ""),
            "prefer_whisper_first": (os.getenv("ASR_PREFER_WHISPER_FIRST", "true").lower() in {"1","true","yes","y"}),
        })

    @app.route('/api/asr', methods=['POST'])
    @login_required
    def api_asr():
        audio = request.files.get('audio')
        if not audio:
            return jsonify({'ok': False, 'error': 'No audio uploaded'}), 400

        lang = (request.form.get('lang') or os.getenv("ASR_LANG") or 'en').strip().lower()
        accent_mode = _accent_mode_from_request(request)

        grammar_json = request.form.get('grammar')
        grammar_words = None
        if grammar_json:
            try:
                grammar_words = json.loads(grammar_json)
            except Exception:
                grammar_words = None

        if grammar_words and accent_mode == "fil":
            try:
                grammar_words = _expand_filipino_variants(grammar_words)
            except Exception as e:
                print("[ASR] grammar expand error:", e)

        prefer_whisper = (os.getenv("ASR_PREFER_WHISPER_FIRST", "true").lower() in {"1", "true", "yes", "y"})

        def _try_whisper():
            out = transcribe_blob_or_501(audio, lang=lang)
            if out.get('ok'):
                out.setdefault('engine', 'whisper')
                out.setdefault('lang', lang)
                out.setdefault('accent', accent_mode or '')
                print(f"[ASR] Using Whisper tokens={len(out.get('tokens', []))}")
                return out, 200
            return out, out.get('status', 500)

        def _try_vosk():
            try:
                vosk_out = transcribe_blob_vosk_or_none(audio, grammar_words=grammar_words)
            except Exception as e:
                print(f"[ASR] VOSK error: {e}")
                vosk_out = None
            if vosk_out and vosk_out.get('ok'):
                vosk_out.setdefault('engine', 'vosk')
                vosk_out.setdefault('lang', lang)
                vosk_out.setdefault('accent', accent_mode or '')
                print(f"[ASR] Using VOSK ({os.getenv('VOSK_MODEL')}) tokens={len(vosk_out.get('tokens', []))}")
                return vosk_out, 200
            return {'ok': False, 'error': 'Vosk failed'}, 500

        if prefer_whisper:
            out, code = _try_whisper()
            if code == 200:
                return jsonify(out), 200
            out, code = _try_vosk()
            return jsonify(out), code
        else:
            out, code = _try_vosk()
            if code == 200:
                return jsonify(out), 200
            out, code = _try_whisper()
            return jsonify(out), code

    # -----------------------------
    # Comprehension page + APIs
    # -----------------------------
    @app.route('/comprehension')
    @login_required
    def comprehension():
        return render_template('comprehension.html')

    @app.route('/api/generate_questions', methods=['POST'])
    @login_required
    def api_generate_questions():
        data = request.get_json(force=True) or {}
        text = (data.get('text') or '').strip()
        pid = data.get('passage_id')
        if not text and pid:
            p = Passage.query.get(pid)
            text = (p.text if p else '')
        if not text:
            return jsonify({"ok": False, "error": "No passage text provided"}), 400

        count = 10
        options_n = 4
        cognitive = data.get("cognitive") or ["analyze","infer","evaluate","interpret"]

        if not _gemini_enabled():
            return jsonify({"ok": False, "error": "Gemini not configured on server. Set GOOGLE_API_KEY or GEMINI_API_KEY and restart."}), 503

        try:
            qs = _generate_hots_mcqs_gemini(text, count=count, options_n=options_n, cognitive=cognitive)
            qs = [q for q in qs if isinstance(q.get("options"), list) and len(q["options"]) == 4]
            if len(qs) < count:
                return jsonify({
                    "ok": False,
                    "error": f"AI returned {len(qs)}/{count} valid items. Try again or set GEMINI_MODEL to a different model."
                }), 502
            return jsonify({"ok": True, "source": "gemini", "model": GEMINI_MODEL, "questions": qs})
        except Exception as e:
            import traceback
            tb = traceback.format_exc(limit=2)
            print("[/api/generate_questions] Gemini error:", e, "\n", tb)
            return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"}), 502

    @app.route('/api/submit_comprehension', methods=['POST'])
    @login_required
    def api_submit_comprehension():
        """
        Scores only the items that were actually answered (choice != null).
        Saves (correct, total_counted) into the session and returns %.
        """
        data = request.get_json(force=True) or {}
        questions = data.get('questions') or []
        answers = data.get('answers') or []

        try:
            correct = 0
            counted = 0  # answered items
            for a in answers:
                try:
                    idx = int(a.get('idx'))
                except Exception:
                    continue
                choice = a.get('choice')
                if choice is None:
                    continue
                counted += 1
                try:
                    if int(choice) == int(questions[idx]['answer_index']):
                        correct += 1
                except Exception:
                    pass

            total = counted
            pct = (correct / total * 100.0) if total else 0.0

            sid = data.get('session_id')
            if sid:
                try:
                    s = Session.query.get(int(sid))
                    if s:
                        if hasattr(Session, 'comprehension_correct') and hasattr(Session, 'comprehension_total'):
                            s.comprehension_correct = correct
                            s.comprehension_total = total
                        else:
                            try:
                                e = json.loads(s.errors_json or '{}')
                            except Exception:
                                e = {}
                            e['comprehension'] = {'correct': correct, 'total': total}
                            s.errors_json = json.dumps(e)
                        db.session.commit()
                except Exception as se:
                    print("[/api/submit_comprehension] session update error:", se)

            return jsonify({
                "ok": True,
                "attempt_id": uuid.uuid4().hex,
                "score_pct": round(pct, 1),
                "correct": correct,
                "total": total
            }), 200
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400

    @app.route('/api/sessions/<int:sid>/comprehension', methods=['POST'])
    @login_required
    def api_update_session_comprehension(sid):
        s = Session.query.get_or_404(sid)
        data = request.get_json(force=True) or {}
        try:
            correct = int(data.get('correct', 0))
            total = int(data.get('total', 0))
        except Exception:
            return jsonify({"ok": False, "error": "correct and total must be integers"}), 400
        if total < 0 or correct < 0 or correct > total:
            return jsonify({"ok": False, "error": "invalid values: 0 <= correct <= total"}), 400

        if hasattr(Session, 'comprehension_correct') and hasattr(Session, 'comprehension_total'):
            s.comprehension_correct = correct
            s.comprehension_total = total
        else:
            try:
                e = json.loads(s.errors_json or '{}')
            except Exception:
                e = {}
            e['comprehension'] = {'correct': correct, 'total': total}
            s.errors_json = json.dumps(e)

        db.session.commit()

        pct = (correct / total * 100.0) if total else 0.0
        return jsonify({
            "ok": True,
            "session_id": s.id,
            "comprehension_correct": correct,
            "comprehension_total": total,
            "comprehension_pct": round(pct, 1)
        }), 200

    # -----------------------------
    # Gemini health check
    # -----------------------------
    @app.route('/api/gemini/health')
    @login_required
    def gemini_health():
        if not _gemini_enabled():
            return jsonify({
                "ok": False,
                "configured": False,
                "model": GEMINI_MODEL,
                "error": "Gemini SDK not ready or API key missing"
            }), 503

        t0 = time.time()
        try:
            resp = _client.models.generate_content(
                model=GEMINI_MODEL,
                contents='Reply with {"status":"ok"} as JSON.',
                config=types.GenerateContentConfig(
                    temperature=0,
                    response_mime_type="application/json"
                ),
            )
            content = (resp.text or "").strip()
            latency_ms = int((time.time() - t0) * 1000)
            try:
                payload = _extract_json_like(content) or {}
                status = str(payload.get("status", "")).lower() == "ok"
            except Exception:
                status = False
            return jsonify({
                "ok": bool(status),
                "configured": True,
                "model": GEMINI_MODEL,
                "latency_ms": latency_ms,
                "raw": content[:200]
            }), 200 if status else 502
        except Exception as e:
            latency_ms = int((time.time() - t0) * 1000)
            return jsonify({
                "ok": False,
                "configured": True,
                "model": GEMINI_MODEL,
                "latency_ms": latency_ms,
                "error": f"{type(e).__name__}: {e}"
            }), 502

    return app


# ----------------- Entrypoint -----------------
app = create_app()

if __name__ == '__main__':
    # For local dev only
    app.run(debug=True)  # or app.run(host="0.0.0.0", port=5000, debug=True)
