"""Run: python3 -m unittest discover -s animations -p 'test_*.py'."""
import unittest
from animations import AnimationLab, MAX_WAVES, MODES, frame


class AnimationFrames(unittest.TestCase):
    def test_invert_tracks_hold(self):
        base = frame(0, 5, 45, -1)
        held = frame(0, 5, 45, 0, True)
        self.assertTrue(all(a != b for r, s in zip(base, held) for a, b in zip(r, s)))
        self.assertEqual(base, frame(0, 5, 45, .3, False))

    def test_wave_starts_at_bottom_middle(self):
        base = frame(1, 5, 10, -1)
        wave = frame(1, 5, 10, .1)
        changed = {(x, y) for y in range(32) for x in range(64) if base[y][x] != wave[y][x]}
        self.assertEqual(changed, {(31, 31), (32, 31)})

    def test_speed_scales_time(self):
        for mode in range(1, 6):
            self.assertEqual(frame(mode, 5, 20, .6), frame(mode, 5, 40, .3))

    def test_thickness_expands_wave(self):
        base = frame(1, 1, 20, -1)
        def changed(width):
            pixels = frame(1, width, 20, 1)
            return {(x, y) for y in range(32) for x in range(64) if base[y][x] != pixels[y][x]}
        self.assertLess(changed(1), changed(8))

    def test_all_effects_return_to_rest(self):
        for mode in range(6):
            self.assertEqual(frame(mode, 16, 5, -1), frame(mode, 16, 5, 20))


class MultipleWaves(unittest.TestCase):
    def test_old_and_new_rings_both_remain_visible(self):
        base = frame(1, 3, 20, -1)
        old = frame(1, 3, 20, 1)
        new = frame(1, 3, 20, .25)
        combined = frame(1, 3, 20, .25, wave_ages=[1, .25])
        changes = [0, 0]
        for y in range(32):
            for x in range(64):
                a, b = old[y][x] != base[y][x], new[y][x] != base[y][x]
                changes[0] += a
                changes[1] += b
                self.assertEqual(combined[y][x] != base[y][x], a or b)
        self.assertTrue(all(changes))

    def test_overlapping_rings_do_not_cancel(self):
        self.assertEqual(frame(1, 5, 20, .5),
                         frame(1, 5, 20, .5, wave_ages=[.5, .5]))

    def test_expired_waves_leave_newer_waves_and_then_clear(self):
        self.assertEqual(frame(1, 5, 20, .5),
                         frame(1, 5, 20, .5, wave_ages=[4, .5]))
        self.assertEqual(frame(1, 5, 20, -1),
                         frame(1, 5, 20, 4, wave_ages=[5, 4]))

    def test_press_history_is_independent_bounded_and_expires(self):
        class Value:
            def __init__(self, value): self.value = value
            def get(self): return self.value
        lab = AnimationLab.__new__(AnimationLab)
        lab.mode = Value(MODES[1])
        lab.thickness = Value(5)
        lab.speed = Value(20)
        lab.started = [None, None]
        lab.waves = [[], []]
        lab.start_effect(0, 1)
        lab.start_effect(0, 1.1)
        lab.start_effect(1, 1.2)
        self.assertEqual(lab.waves, [[1, 1.1], [1.2]])
        for i in range(100):
            lab.start_effect(0, 1.2 + i * .01)
        self.assertEqual(len(lab.waves[0]), MAX_WAVES)
        self.assertEqual(lab.waves[1], [1.2])
        lab.start_effect(0, 10)
        self.assertEqual(lab.waves[0], [10])


class HardwareTiming(unittest.TestCase):
    def test_stats_parsing_and_malformed_input(self):
        class Text:
            value = ''
            def set(self, value):
                self.value = value
        lab = AnimationLab.__new__(AnimationLab)
        lab.timing = Text()
        lab.receive('STATS 6500 7200 0 2')
        self.assertIn('left 6.5 ms', lab.timing.value)
        self.assertIn('right 7.2 ms', lab.timing.value)
        self.assertIn('errors: 0/2', lab.timing.value)
        previous = lab.timing.value
        for invalid in ('STATS junk', 'STATS 10 20 -1 0', 'STATS 1 2 3 4 5'):
            lab.receive(invalid)
            self.assertEqual(previous, lab.timing.value)


if __name__ == '__main__':
    unittest.main()
