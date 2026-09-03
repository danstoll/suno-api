#!/usr/bin/env python
"""
audio-probe.py — measurable substitutes for the listening gates.

    python tools/audio-probe.py --file take.mp3 [--windows 12] [--json]

The controller cannot listen to audio. This tool answers the specific,
narrow questions the plan's listening gates actually needed answered:

  * is there a drum kit at all (has_percussion)?
  * does a new texture arrive partway through the take (enters_in_second_half)?
  * does the take alternate between two states repeatedly, e.g. a slow
    phrase answered by a fast one (alternates)?

Everything is computed per equal-length window over the file (default 12),
then aggregated. These are gates, not taste: they catch "no drums where
drums were asked for", "a texture that never changes", and "an alternation
that never happens" -- not whether the take is good.
"""
import argparse
import json
import os
import statistics

import numpy as np
import librosa

SR = 22050
MEASURES = ('percussive_ratio', 'onset_rate', 'brightness', 'rms_db')


def _window_bounds(duration, windows):
    step = duration / windows
    return [(i * step, (i + 1) * step) for i in range(windows)]


def _analyze_window(y, sr, start, end):
    i0 = int(round(start * sr))
    i1 = len(y) if end >= duration_of(y, sr) - 1e-9 else int(round(end * sr))
    seg = y[i0:i1]
    seconds = max(len(seg) / sr, 1e-9)

    if len(seg) == 0:
        return {
            'start': start, 'end': end,
            'percussive_ratio': 0.0, 'onset_rate': 0.0,
            'brightness': 0.0, 'rms_db': -120.0,
        }

    harmonic, percussive = librosa.effects.hpss(y=seg)
    percussive_energy = float(np.sum(percussive.astype(np.float64) ** 2))
    harmonic_energy = float(np.sum(harmonic.astype(np.float64) ** 2))
    total_energy = percussive_energy + harmonic_energy
    percussive_ratio = percussive_energy / total_energy if total_energy > 1e-12 else 0.0

    onsets = librosa.onset.onset_detect(y=seg, sr=sr, units='time')
    onset_rate = len(onsets) / seconds

    centroid = librosa.feature.spectral_centroid(y=seg, sr=sr)
    brightness = float(np.mean(centroid)) if centroid.size else 0.0

    rms = librosa.feature.rms(y=seg)
    rms_mean = float(np.mean(rms)) if rms.size else 0.0
    rms_db = 20.0 * np.log10(max(rms_mean, 1e-9))

    return {
        'start': start, 'end': end,
        'percussive_ratio': percussive_ratio, 'onset_rate': onset_rate,
        'brightness': brightness, 'rms_db': rms_db,
    }


def duration_of(y, sr):
    return len(y) / sr


def _tempo_of(y, sr):
    try:
        t = librosa.feature.tempo(y=y, sr=sr)
        t = np.atleast_1d(t)
        return float(t[0]) if t.size else 0.0
    except Exception:
        return 0.0


def _half_average(windows, half):
    if not windows:
        return {m: 0.0 for m in MEASURES}
    return {m: float(np.mean([w[m] for w in half])) if half else 0.0 for m in MEASURES}


def probe(path, windows=12):
    y, sr = librosa.load(str(path), sr=SR, mono=True)
    dur = duration_of(y, sr)

    bounds = _window_bounds(dur, windows) if dur > 0 else []
    win_reports = [_analyze_window(y, sr, start, end) for start, end in bounds]

    tempo_windows = []
    for start, end in bounds:
        i0 = int(round(start * sr))
        i1 = len(y) if end >= dur - 1e-9 else int(round(end * sr))
        tempo_windows.append(_tempo_of(y[i0:i1], sr))

    half_idx = len(win_reports) // 2
    first_windows = win_reports[:half_idx]
    second_windows = win_reports[half_idx:]
    first_half = _half_average(win_reports, first_windows)
    second_half = _half_average(win_reports, second_windows)
    delta = {m: second_half[m] - first_half[m] for m in MEASURES}

    percussive_ratio = float(statistics.median([w['percussive_ratio'] for w in win_reports])) if win_reports else 0.0
    onset_rate = float(np.mean([w['onset_rate'] for w in win_reports])) if win_reports else 0.0
    brightness = float(np.mean([w['brightness'] for w in win_reports])) if win_reports else 0.0

    return {
        'file': os.path.basename(str(path)),
        'duration': dur,
        'windows_count': len(win_reports),
        'percussive_ratio': percussive_ratio,
        'onset_rate': onset_rate,
        'brightness': brightness,
        'windows': win_reports,
        'first_half': first_half,
        'second_half': second_half,
        'delta': delta,
        'tempo_windows': tempo_windows,
    }


def has_percussion(report, threshold=0.35):
    ratio = report['percussive_ratio']
    ok = ratio > threshold
    return ok, {'percussive_ratio': ratio, 'threshold': threshold}


def enters_in_second_half(report, key, min_delta_ratio=0.25):
    first_val = report['first_half'][key]
    second_val = report['second_half'][key]
    delta = second_val - first_val
    if abs(first_val) > 1e-9:
        delta_ratio = delta / abs(first_val)
    else:
        delta_ratio = 0.0 if abs(second_val) <= 1e-9 else float('inf')
    ok = delta_ratio >= min_delta_ratio
    evidence = {
        'key': key, 'first_half': first_val, 'second_half': second_val,
        'delta': delta, 'delta_ratio': delta_ratio, 'min_delta_ratio': min_delta_ratio,
    }
    return ok, evidence


def alternates(report, key, min_swing_ratio=0.4):
    vals = [w[key] for w in report['windows']]
    median_val = float(statistics.median(vals)) if vals else 0.0

    classes = []
    for v in vals:
        if abs(median_val) > 1e-9:
            ratio = (v - median_val) / abs(median_val)
        else:
            ratio = 0.0 if abs(v) <= 1e-9 else (float('inf') if v > 0 else float('-inf'))
        if ratio >= min_swing_ratio:
            classes.append(1)
        elif ratio <= -min_swing_ratio:
            classes.append(-1)
        else:
            classes.append(0)

    nonzero = [c for c in classes if c != 0]
    swings = sum(1 for i in range(1, len(nonzero)) if nonzero[i] != nonzero[i - 1])
    ok = swings >= 3
    evidence = {
        'key': key, 'values': vals, 'median': median_val,
        'classes': classes, 'swings': swings, 'min_swing_ratio': min_swing_ratio,
    }
    return ok, evidence


def _print_table(report):
    print(f"file={report['file']} duration={report['duration']:.1f}s windows={report['windows_count']}")
    print(f"percussive_ratio={report['percussive_ratio']:.3f} onset_rate={report['onset_rate']:.2f}/s brightness={report['brightness']:.0f}Hz")
    print(f"{'start':>7} {'end':>7} {'perc':>6} {'onset/s':>8} {'bright':>8} {'rms_db':>8}")
    for w in report['windows']:
        print(f"{w['start']:7.1f} {w['end']:7.1f} {w['percussive_ratio']:6.3f} {w['onset_rate']:8.2f} {w['brightness']:8.0f} {w['rms_db']:8.1f}")

    hp_ok, hp_ev = has_percussion(report)
    br_ok, br_ev = enters_in_second_half(report, 'brightness')
    alt_ok, alt_ev = alternates(report, 'onset_rate')
    print(f"has_percussion={hp_ok} ({hp_ev})")
    print(f"enters_in_second_half(brightness)={br_ok} ({br_ev})")
    print(f"alternates(onset_rate)={alt_ok} ({alt_ev})")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', required=True)
    ap.add_argument('--windows', type=int, default=12)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    rep = probe(args.file, windows=args.windows)
    if args.json:
        print(json.dumps(rep, indent=2))
    else:
        _print_table(rep)
