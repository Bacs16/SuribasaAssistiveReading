# services/asr_vosk.py
import os, tempfile, json

_model = None

def _load_model():
    """Lazy-load the Vosk model from VOSK_MODEL env var."""
    global _model
    if _model is not None:
        return _model
    try:
        from vosk import Model
    except Exception:
        return None
    path = os.environ.get("VOSK_MODEL")
    if not path or not os.path.isdir(path):
        return None
    _model = Model(path)
    return _model

def transcribe_blob_vosk_or_none(file_storage, grammar_words=None, sr=16000):
    """
    Transcribe an uploaded audio file using Vosk.
    If model unavailable, returns None so caller can fall back.
    Returns: {"ok": True, "engine": "vosk", "tokens": [{text, confidence, final}, ...]}
    """
    # Import here so missing deps don't break module import
    try:
        from vosk import KaldiRecognizer
        from pydub import AudioSegment
    except Exception:
        return None

    model = _load_model()
    if model is None:
        return None

    # Save upload to a temp file
    fd, tmp = tempfile.mkstemp(suffix='.webm')
    os.close(fd)
    file_storage.save(tmp)

    try:
        # Decode to PCM 16k mono
        audio = AudioSegment.from_file(tmp)
        audio = audio.set_channels(1).set_frame_rate(sr).set_sample_width(2)
        pcm = audio.raw_data

        # Build grammar JSON (list of allowed words) if provided
        grammar = None
        if grammar_words:
            uniq, seen = [], set()
            for w in grammar_words:
                w = (w or "").strip().lower()
                if w and w not in seen:
                    uniq.append(w); seen.add(w)
            grammar = json.dumps(uniq)

        rec = KaldiRecognizer(model, sr, grammar) if grammar else KaldiRecognizer(model, sr)

        # Feed PCM to recognizer
        step = 4000
        for i in range(0, len(pcm), step):
            rec.AcceptWaveform(pcm[i:i+step])

        # Final result -> tokens
        out = rec.FinalResult()
        try:
            j = json.loads(out)
        except Exception:
            j = {"text": ""}

        tokens = [{"text": t, "confidence": 0.9, "final": True}
                  for t in (j.get("text","").strip().split())]
        return {"ok": True, "engine": "vosk", "tokens": tokens}

    finally:
        try: os.remove(tmp)
        except Exception: pass
