"""Generate approved phrase audio into a separate output directory."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KModel, KPipeline

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', type=Path, required=True)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
repo_id = 'hexgrad/Kokoro-82M-v1.1-zh'
model_file = args.model_dir / 'kokoro-v1_1-zh.pth'
with model_file.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
if digest != 'b1d8410fa44dfb5c15471fd6c4225ea6b4e9ac7fa03c98e8bea47a9928476e2b':
    raise ValueError('Model checksum mismatch')
project = Path(__file__).resolve().parent
phrases = json.loads((project / 'content' / 'phrases.json').read_text(encoding='utf-8-sig'))
model = KModel(repo_id=repo_id, config=str(args.model_dir / 'config.json'), model=str(model_file)).eval()
pipeline = KPipeline(lang_code='z', repo_id=repo_id, model=model)
args.output_dir.mkdir(parents=True, exist_ok=True)
records = []
for phrase in phrases:
    chunks = list(pipeline(phrase['text'], voice=str(args.model_dir / 'voices' / 'zf_001.pt'), speed=0.85))
    if not chunks:
        raise ValueError(f"No output for {phrase['id']}")
    audio = np.concatenate([chunk.audio.numpy() for chunk in chunks])
    if not np.isfinite(audio).all() or np.max(np.abs(audio)) <= 0:
        raise ValueError(f"Invalid audio for {phrase['id']}")
    target = args.output_dir / Path(phrase['audio']).name
    sf.write(target, audio, 24000, subtype='PCM_16')
    info = sf.info(target)
    with target.open('rb') as source:
        audio_hash = hashlib.file_digest(source, 'sha256').hexdigest()
    records.append({'id': phrase['id'], 'text': phrase['text'], 'audio': phrase['audio'], 'duration_sec': round(info.duration, 3), 'sample_rate': info.samplerate, 'channels': info.channels, 'sha256': audio_hash})
    print(f"Generated {target.name}: {info.duration:.3f}s", flush=True)
record = {'model': repo_id, 'model_sha256': digest, 'voice': 'zf_001', 'speed': 0.85, 'format': 'PCM_16 WAV', 'phrases': records}
(args.output_dir / 'audio-generation-record.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
