"""Generate Mandarin examples into an independent output directory."""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path

import edge_tts


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--samples', help='Reuse approved samples with identical settings')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    phrases = json.loads((root / 'content/phrases.json').read_text(encoding='utf-8-sig'))
    records = []
    for phrase in phrases:
        target = output / f"{phrase['id']}.mp3"
        sample = Path(args.samples) / f"{phrase['id']}-xiaoxiao.mp3" if args.samples else None
        if sample and sample.exists():
            target.write_bytes(sample.read_bytes())
        else:
            await edge_tts.Communicate(phrase['text'], 'zh-CN-XiaoxiaoNeural', rate='-10%').save(str(target))
        if target.stat().st_size < 1000:
            raise RuntimeError(f"Incomplete audio: {target.name}")
        records.append({**phrase, 'audio': f"audio/{target.name}", 'bytes': target.stat().st_size,
                        'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        print(f"Prepared: {phrase['id']} ({target.stat().st_size} bytes)", flush=True)
    record = {'service': 'Microsoft Edge online text-to-speech', 'voice': 'zh-CN-XiaoxiaoNeural',
              'rate': '-10%', 'format': 'MP3', 'generator': f'edge-tts {edge_tts.__version__}',
              'generated_on': '2026-10-06', 'phrases': records}
    (output / 'audio-generation-record.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


asyncio.run(main())
