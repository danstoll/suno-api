import unittest, os, sys, importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent.parent / 'daddy-wombat-tunes' / 'the-long-line' / 'source'
spec = importlib.util.spec_from_file_location('slice_midi', HERE / 'slice-midi.py')
sm = importlib.util.module_from_spec(spec); spec.loader.exec_module(sm)


class BarMap(unittest.TestCase):
    def test_movement_one_switches_meter_at_bar_five(self):
        tpb, ts_map, voices = sm.load_voices(SRC / 'SonataIV.mid')
        total = max(e for v in voices.values() for _, e, _, _ in v)
        bars = sm.bar_bounds(tpb, ts_map, total)
        self.assertEqual(len(bars), 65)
        self.assertEqual(bars[0], (0, 4 * tpb))          # bar 1: 4/4
        self.assertEqual(bars[4][0], 4 * 4 * tpb)         # bar 5 starts after four 4/4 bars
        self.assertEqual(bars[4][1] - bars[4][0], 3 * tpb)  # bar 5: 3/4

    def test_andante_and_allegro_bar_counts(self):
        for f, n in [('SonataIV-1.mid', 45), ('SonataIV-2.mid', 97)]:
            tpb, ts_map, voices = sm.load_voices(SRC / f)
            total = max(e for v in voices.values() for _, e, _, _ in v)
            self.assertEqual(len(sm.bar_bounds(tpb, ts_map, total)), n, f)

    def test_voice_names(self):
        _, _, voices = sm.load_voices(SRC / 'SonataIV-1.mid')
        self.assertEqual(set(voices), {'right', 'left', 'feet'})


class Segments(unittest.TestCase):
    def test_feet_only_filter_and_octave_shift(self):
        src = sm.load_voices(SRC / 'SonataIV-1.mid')
        all_notes, _, _ = sm.segment_notes(src, (1, 2), None, {})
        feet, length, quarters = sm.segment_notes(src, (1, 2), ['feet'], {'feet': -1})
        self.assertLess(len(feet), len(all_notes))
        self.assertEqual(quarters, 8.0)                   # two 4/4 bars
        feet_plain, _, _ = sm.segment_notes(src, (1, 2), ['feet'], {})
        # segment_notes tuples are (voice, start, end, note)
        self.assertEqual(sorted(n for _, _, _, n in feet), sorted(n - 12 for _, _, _, n in feet_plain))

    def test_quarters_for_three_eight(self):
        src = sm.load_voices(SRC / 'SonataIV-2.mid')
        _, _, quarters = sm.segment_notes(src, (1, 4), None, {})
        self.assertEqual(quarters, 6.0)                   # four 3/8 bars = 6 quarters


class Assemble(unittest.TestCase):
    def test_first_thread_expected_and_midi_length(self):
        entry = {"num": "01", "title": "First Thread", "targetSeconds": 112, "segments": [
            {"midi": "SonataIV.mid", "bars": [1, 4], "qpm": 30},
            {"midi": "SonataIV.mid", "bars": [1, 4], "qpm": 30},
            {"midi": "SonataIV.mid", "bars": [5, 20], "qpm": 60}]}
        mf, expected = sm.assemble(entry, SRC)
        self.assertAlmostEqual(expected, 112.0, delta=0.01)
        self.assertAlmostEqual(mf.length, 112.0 + sm.TAIL_PAD_SECONDS, delta=0.6)

    def test_hold_extends_final_notes(self):
        base = {"num": "12", "title": "x", "targetSeconds": 40, "segments": [
            {"midi": "SonataIV-1.mid", "bars": [1, 4], "qpm": 33}]}
        held = dict(base, holdLastNoteSeconds=8)
        self.assertAlmostEqual(sm.assemble(held, SRC)[1] - sm.assemble(base, SRC)[1], 8.0, delta=0.01)
        self.assertAlmostEqual(sm.assemble(held, SRC)[0].length - sm.assemble(base, SRC)[0].length, 8.0, delta=0.6)

    def test_programs_are_piano_and_cello(self):
        entry = {"num": "t", "title": "t", "targetSeconds": 1, "segments": [
            {"midi": "SonataIV-1.mid", "bars": [1, 1], "qpm": 60}]}
        mf, _ = sm.assemble(entry, SRC)
        progs = {(m.channel, m.program) for t in mf.tracks for m in t if m.type == 'program_change'}
        self.assertEqual(progs, {(0, 0), (1, 0), (2, 42)})


if __name__ == '__main__':
    unittest.main()
