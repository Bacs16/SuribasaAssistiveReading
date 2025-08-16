import os, tempfile, json
from io import BytesIO

def transcribe_blob_or_501(file_storage, lang='en'):
    """ Try to use faster-whisper for server-side ASR. If unavailable, return 501. """
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        return {'ok': False, 'status': 501, 'error': 'Server ASR not available (faster-whisper not installed).'}

    # Save to temp file
    fd, tmp = tempfile.mkstemp(suffix='.webm')
    os.close(fd)
    file_storage.save(tmp)

    # Init model once (cache in global)
    global _whisper_model
    if '_whisper_model' not in globals():
        device = os.environ.get('ASR_DEVICE', 'cpu')
        _whisper_model = WhisperModel('base', device=device)

    # Transcribe
    segments, info = _whisper_model.transcribe(tmp, language=lang, vad_filter=True)
    tokens = []
    for seg in segments:
        tokens.extend(seg.text.strip().split())

    # Build simple tokens with dummy confidences (whisper python api doesn't expose token conf directly)
    result = {'ok': True, 'tokens': [{'text': t, 'confidence': 0.8} for t in tokens]}
    try:
        os.remove(tmp)
    except Exception:
        pass
    return result