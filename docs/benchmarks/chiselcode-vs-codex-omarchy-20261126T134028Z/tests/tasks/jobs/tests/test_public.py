import unittest
from solution import schedule

class PublicTest(unittest.TestCase):
    def test_example(self):
        self.assertEqual(schedule(*[{"x": []}]), {"waves": [["x"]], "blocked": []})


if __name__ == "__main__":
    unittest.main()
