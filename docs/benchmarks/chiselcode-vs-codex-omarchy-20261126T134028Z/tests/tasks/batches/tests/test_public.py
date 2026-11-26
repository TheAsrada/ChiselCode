import unittest
from solution import apply_batches

class PublicTest(unittest.TestCase):
    def test_example(self):
        self.assertEqual(apply_batches(*[{"m": 2}, [{"id": "a", "lines": [["m", 1]]}]]), {"stock": {"m": 3}, "statuses": ["applied"]})


if __name__ == "__main__":
    unittest.main()
