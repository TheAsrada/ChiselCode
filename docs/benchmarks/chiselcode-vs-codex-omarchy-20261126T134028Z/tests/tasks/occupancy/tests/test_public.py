import unittest
from solution import occupancy

class PublicTest(unittest.TestCase):
    def test_example(self):
        self.assertEqual(occupancy(*[[], 4, 9]), {"area": 0, "peak": 0, "peak_at": 4})


if __name__ == "__main__":
    unittest.main()
