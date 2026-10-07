"""Generate Mandarin examples into an independent output directory."""
import argparse
import asyncio
import hashlib
import json
from datetime import date
from pathlib import Path

import edge_tts


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--rate', default='-30%')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    phrases = json.loads((root / 'content/phrases.json').read_text(encoding='utf-8-sig'))
    records = []
    for phrase in phrases:
        target = output / f"{phrase['id']}.mp3"
        for attempt in range(3):
            try:
                await edge_tts.Communicate(phrase['text'], 'zh-CN-XiaoxiaoNeural', rate=args.rate).save(str(target))
                break
            except Exception:
                if attempt == 2:
                    raise
                await asyncio.sleep(2)
        if target.stat().st_size < 1000:
            raise RuntimeError(f"Incomplete audio: {target.name}")
        records.append({**phrase, 'bytes': target.stat().st_size,
                        'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        print(f"Prepared: {phrase['id']} ({target.stat().st_size} bytes)", flush=True)
    record = {'service': 'Microsoft Edge online text-to-speech', 'voice': 'zh-CN-XiaoxiaoNeural',
              'rate': args.rate, 'format': 'MP3', 'generator': f'edge-tts {edge_tts.__version__}',
              'generated_on': date.today().isoformat(), 'phrases': records}
    (output / 'audio-generation-record.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


asyncio.run(main())
