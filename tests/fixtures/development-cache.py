"""Exercise host retention without deleting foreign entries."""
from pathlib import Path
import runpy
import json
import tempfile
import unittest

cache = runpy.run_path(str(Path(__file__).resolve().parents[2]/'scripts/dev/image-cache.py'))


class Cache(unittest.TestCase):
    def test_retention(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = cache['initialize'](Path(temporary)/'cache')
            foreign = root/('f'*64); foreign.mkdir(); (foreign/'keep').touch()
            outside = Path(temporary)/'outside'; outside.mkdir(); (outside/'keep').touch()
            (root/('e'*64)).symlink_to(outside, target_is_directory=True)
            for number in range(1, 5):
                key = str(number)*64
                entry = root/key; entry.mkdir(); (entry/'.owner').write_text(cache['MARKER']+'\n')
                cache['record'](root, '0.1.'+str(number), key)
            self.assertFalse((root/('1'*64)).exists())
            for number in range(2, 5): self.assertTrue((root/(str(number)*64)).exists())
            self.assertTrue((foreign/'keep').exists()); self.assertTrue((outside/'keep').exists())
            cache['record'](root, '0.1.5', '4'*64)
            versions = json.loads((root/'versions.json').read_text())
            self.assertEqual(len(versions), 3)
            self.assertEqual(set(versions), {'0.1.3', '0.1.4', '0.1.5'})
            cache['record'](root, '0.1.6', '4'*64)
            cache['record'](root, '0.1.7', '4'*64)
            self.assertNotIn('0.1.4', json.loads((root/'versions.json').read_text()))
            self.assertTrue((root/('4'*64)).exists())
            unowned = Path(temporary)/'unowned'; unowned.mkdir()
            with self.assertRaisesRegex(ValueError, 'not owned'): cache['initialize'](unowned)


if __name__ == '__main__': unittest.main()
