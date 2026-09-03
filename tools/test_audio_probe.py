import unittest, subprocess, tempfile, importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('audio_probe', HERE / 'audio-probe.py')
ap = importlib.util.module_from_spec(spec); spec.loader.exec_module(ap)


def ffmpeg(*a):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *a], check=True)


class Probe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        # a sustained tone: no percussion, steady brightness
        cls.tone = cls.tmp / 'tone.wav'
        ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=22050:duration=20', str(cls.tone))
        # clicks: strongly percussive, high onset rate
        cls.clicks = cls.tmp / 'clicks.wav'
        ffmpeg('-f', 'lavfi', '-i',
               "aevalsrc=exprs='random(0)*2-1':s=22050:d=20", '-af',
               'aformat=channel_layouts=mono,highpass=f=2000,tremolo=f=8:d=1', str(cls.clicks))
        # quiet tone for 10s, then tone plus bright clicks for 10s
        cls.late = cls.tmp / 'late.wav'
        half = cls.tmp / 'half.wav'
        ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=22050:duration=10', str(half))
        mixed = cls.tmp / 'mixed.wav'
        ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=22050:duration=10',
               '-f', 'lavfi', '-i', 'sine=frequency=3000:sample_rate=22050:duration=10',
               '-filter_complex', '[0:a][1:a]amix=inputs=2', str(mixed))
        ffmpeg('-i', str(half), '-i', str(mixed), '-filter_complex',
               '[0:a][1:a]concat=n=2:v=0:a=1', str(cls.late))

    def test_tone_has_no_percussion_and_clicks_do(self):
        quiet = ap.probe(self.tone)
        busy = ap.probe(self.clicks)
        self.assertFalse(ap.has_percussion(quiet)[0], quiet['percussive_ratio'])
        self.assertTrue(ap.has_percussion(busy)[0], busy['percussive_ratio'])

    def test_brightness_rises_in_the_second_half(self):
        rep = ap.probe(self.late)
        ok, ev = ap.enters_in_second_half(rep, 'brightness')
        self.assertTrue(ok, ev)
        self.assertFalse(ap.enters_in_second_half(ap.probe(self.tone), 'brightness')[0])

    def test_report_shape(self):
        rep = ap.probe(self.tone, windows=8)
        self.assertEqual(len(rep['windows']), 8)
        for key in ('percussive_ratio', 'onset_rate', 'brightness', 'windows', 'first_half', 'second_half', 'tempo_windows'):
            self.assertIn(key, rep)
        self.assertTrue(all('rms_db' in w for w in rep['windows']))


if __name__ == '__main__':
    unittest.main()
