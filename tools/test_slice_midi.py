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

    def test_boundary_note_sustaining_into_segment_is_not_dropped(self):
        # SonataIV.mid bar 50: a left-hand note (note 64) starts before the bar and
        # sustains 1344 source ticks (3.5 quarter notes) across the boundary. It must be
        # admitted starting at tick 0 of the segment, not dropped because it didn't START
        # inside the window.
        src = sm.load_voices(SRC / 'SonataIV.mid')
        notes, length, quarters = sm.segment_notes(src, (50, 50), ['left'], {})
        self.assertTrue(notes, 'the note sustaining across the bar-50 boundary was dropped')
        crossing = [n for n in notes if n[1] == 0]
        self.assertEqual(len(crossing), 1)
        self.assertGreater(crossing[0][2], 0)


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

    def test_hold_extends_the_note_actually_sounding_last(self):
        # SonataIV-1.mid bar 1, feet voice: the only note ends 192 source ticks (0.5
        # quarter) before the bar's structural boundary. A hold window measured from
        # that boundary misses it entirely; the fix must find and extend the real last
        # note (not just pad silence onto the end of the bar) by exactly the requested
        # number of seconds.
        entry = {"num": "t3", "title": "t3", "targetSeconds": 1, "segments": [
            {"midi": "SonataIV-1.mid", "bars": [1, 1], "qpm": 60, "voices": ["feet"]}]}
        held = dict(entry, holdLastNoteSeconds=2)

        def feet_note_off_tick(mf):
            track = next(t for t in mf.tracks if any(m.type == 'program_change' and m.channel == 2 for m in t))
            tick, last_off = 0, None
            for msg in track:
                tick += msg.time
                if msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
                    last_off = tick
            return last_off

        base_off = feet_note_off_tick(sm.assemble(entry, SRC)[0])
        held_off = feet_note_off_tick(sm.assemble(held, SRC)[0])
        hold_ticks = round(2 * 60 / 60.0 * sm.OUT_TPB)   # 2s at qpm 60
        self.assertEqual(held_off - base_off, hold_ticks)


class BarBoundsValidation(unittest.TestCase):
    def test_bar_bounds_rejects_non_positive_time_signature(self):
        with self.assertRaises(ValueError):
            sm.bar_bounds(384, [(0, 4, 0)], 1536)


if __name__ == '__main__':
    unittest.main()
