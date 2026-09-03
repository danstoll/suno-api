import unittest, subprocess, tempfile, importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('melody_match', HERE / 'melody-match.py')
mm = importlib.util.module_from_spec(spec); spec.loader.exec_module(mm)


def ffmpeg(*a):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *a], check=True)


class Score(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.melody = cls.tmp / 'melody.wav'
        # a four-note "melody": A3 C4 E4 A4, one second each, then the same again
        ffmpeg('-f', 'lavfi', '-i',
               "aevalsrc=exprs='sin(2*PI*220*t)*lt(mod(t\\,4)\\,1)+sin(2*PI*261.63*t)*between(mod(t\\,4)\\,1\\,2)+sin(2*PI*329.63*t)*between(mod(t\\,4)\\,2\\,3)+sin(2*PI*440*t)*gte(mod(t\\,4)\\,3)':s=22050:d=8",
               str(cls.melody))
        cls.noise = cls.tmp / 'noise.wav'
        ffmpeg('-f', 'lavfi', '-i', 'anoisesrc=color=pink:r=22050:d=8', str(cls.noise))
        cls.slower = cls.tmp / 'slower.wav'
        ffmpeg('-i', str(cls.melody), '-af', 'atempo=0.8', str(cls.slower))

    def test_identical_scores_near_one(self):
        self.assertGreater(mm.score(self.melody, self.melody), 0.97)

    def test_noise_scores_low(self):
        self.assertLess(mm.score(self.melody, self.noise), 0.6)

    def test_tempo_change_still_matches(self):
        self.assertGreater(mm.score(self.melody, self.slower), 0.9)


if __name__ == '__main__':
    unittest.main()
