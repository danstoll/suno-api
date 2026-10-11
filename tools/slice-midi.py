#!/usr/bin/env python
"""
slice-midi.py — render per-track reference slices for The Long Line v2.

Reads a slice manifest (suno-api/the-long-line-slices.json), cuts bar ranges
out of the Mutopia BWV 528 MIDI files, sets a tempo per segment, restricts
voices where asked, concatenates the segments, renders with fluidsynth +
GeneralUser GS, and encodes MP3. Prints a duration report and exits 1 if any
slice lands outside ±10% of its target (spec §5).

    python tools/slice-midi.py --manifest the-long-line-slices.json \
        --source-dir ../daddy-wombat-tunes/vombatus/the-long-line/source \
        --out-dir ../daddy-wombat-tunes/vombatus/the-long-line/refs [--only 01,06] [--midi-only]

Bars in the manifest are FILE bars (1-based, inclusive). Movement I's file
holds the Adagio as bars 1-4 and the Vivace as bars 5-65.
"""
import argparse, json, subprocess, sys
from pathlib import Path
import mido
from mido import MidiFile, MidiTrack, MetaMessage, Message

TOOLS = Path(__file__).resolve().parent
FLUIDSYNTH = TOOLS / 'fluidsynth' / 'fluidsynth-v2.6.0-win10-x64-cpp11' / 'bin' / 'fluidsynth.exe'
SOUNDFONT = TOOLS / 'GeneralUser-GS.sf2'
OUT_TPB = 960
CHANNEL = {'right': 0, 'left': 1, 'feet': 2}
PROGRAM = {'right': 0, 'left': 0, 'feet': 42}      # acoustic grand ×2, cello
VELOCITY = {'right': 100, 'left': 88, 'feet': 84}  # the source is a flat 127 everywhere
TAIL_PAD_SECONDS = 1.5                             # let the reverb tail finish before the file ends
TOLERANCE = 0.10


def load_voices(path):
    """-> (ticks_per_beat, [(abs_tick, num, den)], {voice: [(start, end, note, vel)]})"""
    mf = MidiFile(path)
    tpb = mf.ticks_per_beat
    ts_map, voices = [], {}
    for track in mf.tracks:
        tick, name, open_notes, notes = 0, None, {}, []
        for msg in track:
            tick += msg.time
            if msg.type == 'track_name':
                name = msg.name.strip()
            elif msg.type == 'time_signature':
                ts_map.append((tick, msg.numerator, msg.denominator))
            elif msg.type == 'note_on' and msg.velocity > 0:
                open_notes.setdefault(msg.note, []).append(tick)
            elif msg.type in ('note_off', 'note_on'):
                starts = open_notes.get(msg.note)
                if starts:
                    notes.append((starts.pop(0), tick, msg.note, 127))
        if notes and name in CHANNEL:
            voices[name] = sorted(notes)
    ts_map = sorted(set(ts_map))
    if not ts_map:
        ts_map = [(0, 4, 4)]
    return tpb, ts_map, voices


def bar_bounds(tpb, ts_map, total_ticks):
    """List of (start_tick, end_tick) for bars 1..N covering total_ticks."""
    bounds, tick, i = [], 0, 0
    while tick < total_ticks:
        while i + 1 < len(ts_map) and ts_map[i + 1][0] <= tick:
            i += 1
        _, num, den = ts_map[i]
        if num <= 0 or den <= 0:
            raise ValueError(f'invalid time signature {num}/{den} at tick {tick}')
        length = int(round(tpb * num * 4 / den))
        if length <= 0:
            raise ValueError(f'time signature {num}/{den} at tick {tick} yields non-positive bar length {length}')
        bounds.append((tick, tick + length))
        tick += length
    return bounds


def segment_notes(src, bars, voice_names, octave_shift):
    """Cut bars a..b (file bars) -> (notes relative to segment start, length_ticks, quarters)."""
    tpb, ts_map, voices = src
    total = max(e for v in voices.values() for _, e, _, _ in v)
    bounds = bar_bounds(tpb, ts_map, total)
    a, b = bars
    if a < 1 or b > len(bounds) or a > b:
        raise ValueError(f'bars {bars} outside 1..{len(bounds)}')
    seg_start, seg_end = bounds[a - 1][0], bounds[b - 1][1]
    out = []
    for name in (voice_names or list(voices)):
        shift = 12 * int(octave_shift.get(name, 0))
        for s, e, n, v in voices[name]:
            if s < seg_end and e > seg_start:
                out.append((name, max(s, seg_start) - seg_start, min(e, seg_end) - seg_start, max(0, min(127, n + shift))))
    return out, seg_end - seg_start, (seg_end - seg_start) / tpb


def assemble(entry, source_dir):
    """Build one MidiFile for a manifest entry -> (MidiFile, expected_seconds)."""
    source_dir = Path(source_dir)
    cache, expected, cursor, tempo_events, per_voice = {}, 0.0, 0, [], {v: [] for v in CHANNEL}
    last_qpm, last_seg_end = 120.0, 0
    for seg in entry['segments']:
        src = cache.setdefault(seg['midi'], load_voices(source_dir / seg['midi']))
        tpb = src[0]
        scale = OUT_TPB / tpb
        notes, length, quarters = segment_notes(src, tuple(seg['bars']), seg.get('voices'), seg.get('octaveShift', {}))
        qpm = float(seg['qpm'])
        tempo_events.append((cursor, qpm))
        for name, s, e, n in notes:
            per_voice[name].append([cursor + int(round(s * scale)), cursor + int(round(e * scale)), n])
        cursor += int(round(length * scale))
        expected += quarters / qpm * 60.0
        last_qpm, last_seg_end = qpm, cursor
    hold = float(entry.get('holdLastNoteSeconds', 0) or 0)
    if hold > 0:
        hold_ticks = int(round(hold * last_qpm / 60.0 * OUT_TPB))
        near = OUT_TPB // 4
        max_end = max((n[1] for notes in per_voice.values() for n in notes), default=last_seg_end)
        for name in per_voice:
            for note in per_voice[name]:
                if note[1] >= max_end - near:
                    note[1] += hold_ticks
        cursor = max(last_seg_end, max_end) + hold_ticks
        expected += hold
    pad_ticks = int(round(TAIL_PAD_SECONDS * last_qpm / 60.0 * OUT_TPB))

    mf = MidiFile(ticks_per_beat=OUT_TPB, type=1)
    meta = MidiTrack(); mf.tracks.append(meta)
    meta.append(MetaMessage('track_name', name=f"{entry['num']} {entry['title']}", time=0))
    t = 0
    for tick, qpm in tempo_events:
        meta.append(MetaMessage('set_tempo', tempo=mido.bpm2tempo(qpm), time=tick - t)); t = tick
    meta.append(MetaMessage('end_of_track', time=(cursor + pad_ticks) - t))
    for name, ch in CHANNEL.items():
        tr = MidiTrack(); mf.tracks.append(tr)
        tr.append(MetaMessage('track_name', name=name, time=0))
        tr.append(Message('program_change', channel=ch, program=PROGRAM[name], time=0))
        events = []
        for s, e, n in per_voice[name]:
            events.append((s, 1, n)); events.append((max(e, s + 1), 0, n))
        events.sort(key=lambda x: (x[0], x[1]))   # offs before ons at the same tick
        t = 0
        for tick, on, n in events:
            tr.append(Message('note_on' if on else 'note_off', channel=ch, note=n,
                              velocity=VELOCITY[name] if on else 0, time=tick - t)); t = tick
        tr.append(MetaMessage('end_of_track', time=max(0, (cursor + pad_ticks) - t)))
    return mf, expected


def render(mid_path, wav_path):
    subprocess.run([str(FLUIDSYNTH), '-ni', '-q', '-F', str(wav_path), '-r', '44100', '-g', '0.6',
                    str(SOUNDFONT), str(mid_path)], check=True)


def encode_mp3(wav_path, mp3_path):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav_path), '-codec:a', 'libmp3lame',
                    '-b:a', '192k', str(mp3_path)], check=True)


def probe_seconds(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def slug(title):
    return ''.join(c.lower() if c.isalnum() else '-' for c in title).strip('-').replace('--', '-')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--source-dir', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--only', help='comma-separated track nums, e.g. 01,06')
    ap.add_argument('--midi-only', action='store_true')
    args = ap.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding='utf8'))
    only = set(args.only.split(',')) if args.only else None
    out_dir = Path(args.out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    rows, bad = [], 0
    for entry in manifest:
        if only and entry['num'] not in only:
            continue
        part = f"-part{entry['part']}" if entry.get('part') else ''
        base = out_dir / f"{entry['num']}-{slug(entry['title'])}-ref{part}"
        mf, expected = assemble(entry, args.source_dir)
        mf.save(str(base) + '.mid')
        actual = None
        if not args.midi_only:
            render(str(base) + '.mid', str(base) + '.wav')
            encode_mp3(str(base) + '.wav', str(base) + '.mp3')
            actual = probe_seconds(str(base) + '.mp3') - TAIL_PAD_SECONDS
        target = float(entry['targetSeconds'])
        check = actual if actual is not None else expected
        ok = abs(check - target) <= TOLERANCE * target
        bad += 0 if ok else 1
        rows.append((entry['num'] + part, entry['title'], target, expected, actual, ok))
    print(f"\n{'#':<8}{'title':<20}{'target':>8}{'expected':>10}{'actual':>9}  ok")
    for num, title, target, expected, actual, ok in rows:
        a = f'{actual:9.1f}' if actual is not None else f"{'(midi)':>9}"
        print(f'{num:<8}{title:<20}{target:8.0f}{expected:10.1f}{a}  {"ok" if ok else "OUT OF RANGE"}')
    if bad:
        print(f'\n{bad} slice(s) outside ±{int(TOLERANCE*100)}% of target — adjust qpm in the manifest.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
