from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
from werkzeug.security import generate_password_hash

db = SQLAlchemy()

# ----------------------------- Core Models ------------------------------

class Passage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    text = db.Column(db.Text, nullable=False)
    grade_level = db.Column(db.String(50), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Session(db.Model):
    id = db.Column(db.Integer, primary_key=True)

    # Link to passage
    passage_id = db.Column(db.Integer, db.ForeignKey('passage.id'), nullable=True, index=True)
    passage = db.relationship('Passage')

    # ----------------- NEW: required learner identity fields -----------------
    surname = db.Column(db.String(128), nullable=False)          # required
    first_name = db.Column(db.String(128), nullable=False)       # required
    middle_initial = db.Column(db.String(8), nullable=False)     # required (e.g., "A" or "A.")
    grade_level = db.Column(db.String(16), nullable=False)       # required (e.g., "4", "5", "6")

    # Legacy (kept for backward compatibility; no longer used to save)
    student_name = db.Column(db.String(120), nullable=True)

    # Timing & scores
    started_at = db.Column(db.DateTime, default=datetime.utcnow)
    duration_sec = db.Column(db.Float, default=0.0)
    wcpm = db.Column(db.Float, default=0.0)
    accuracy = db.Column(db.Float, default=0.0)
    errors_json = db.Column(db.Text, nullable=True)  # serialized details of wrong/misread words

    # Comprehension (correct/total)
    comprehension_correct = db.Column(db.Integer, default=0)
    comprehension_total = db.Column(db.Integer, default=0)

    # Convenience: access word events via relationship
    word_events = db.relationship(
        'WordEvent',
        backref='session',
        cascade='all, delete-orphan',
        passive_deletes=True
    )

    # Convenience: formatted name for templates (e.g., results.html)
    @property
    def student_display_name(self) -> str:
        mi = (self.middle_initial or "").strip().rstrip(".")
        mi_part = f" {mi}." if mi else ""
        # "Surname, First M."
        return f"{self.surname}, {self.first_name}{mi_part}"


class WordEvent(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(
        db.Integer,
        db.ForeignKey('session.id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )
    word_index = db.Column(db.Integer, nullable=False)
    status = db.Column(db.String(20), nullable=False)  # pending|correct|misread|skipped
    start_ms = db.Column(db.Float)
    end_ms = db.Column(db.Float)
    asr_text = db.Column(db.String(255))
    confidence = db.Column(db.Float)

# ----------------------------- Auth & Profile ---------------------------

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    profile = db.relationship('Profile', uselist=False, backref='user', cascade='all, delete-orphan')


class Profile(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        db.Integer,
        db.ForeignKey('user.id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )

    teacher_name = db.Column(db.String(200))
    grade = db.Column(db.String(20))            # e.g., "Grade 4"
    section = db.Column(db.String(50))
    school_id = db.Column(db.String(50))
    school = db.Column(db.String(200))
    screening_level = db.Column(db.String(50))  # e.g., "Level 1"
    total_enrolment = db.Column(db.Integer)
    school_head = db.Column(db.String(200))
    subject = db.Column(db.String(120))
    school_year = db.Column(db.String(50))

    # relative path under /static (e.g., "uploads/user3_1712345678.jpg")
    avatar_path = db.Column(db.String(255))

    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# ----------------------------- Seeding ----------------------------------

def seed_initial_data():
    """Create sample passages and a default admin user on first run."""
    # Seed passages
    if Passage.query.count() == 0:
        p1 = Passage(
            title='The Wind and the Sun',
            grade_level='4',
            text=('The wind and the sun argued about which was stronger. '
                  'A traveler came along, and they decided whoever made him '
                  'remove his coat would be the stronger.')
        )
        p2 = Passage(
            title='Seeds and Soil',
            grade_level='5',
            text=('Seeds slept in the soil through winter. With spring rain and warm light, '
                  'they woke and reached for the sky.')
        )
        db.session.add_all([p1, p2])
        db.session.commit()

    # Seed default admin user (email: admin@example.com / password: admin123)
    try:
        if not User.query.filter_by(email='admin@example.com').first():
            u = User(email='admin@example.com',
                     password_hash=generate_password_hash('admin123'))
            db.session.add(u)
            db.session.commit()
    except Exception as e:
        # If tables aren't there for some reason, don't block app start
        print(f'[seed_initial_data] Skipped seeding user: {e}')
