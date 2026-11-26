import unittest
from solution import replay

class PublicTest(unittest.TestCase):
    def test_example(self):
        self.assertEqual(replay(*[['{"seq":2,"id":"a","key":"x","op":"set","value":1}'],0]), {"state": {"x": 1}, "issues": [], "watermark": 2})


if __name__ == "__main__":
    unittest.main()
