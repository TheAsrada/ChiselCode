import unittest
from solution import page

class PublicTest(unittest.TestCase):
    def test_example(self):
        self.assertEqual(page(*[[{"id": "x", "score": 4, "team": "t"}], 1, None, None]), {"rows": [{"id": "x", "score": 4, "team": "t"}], "next": None})


if __name__ == "__main__":
    unittest.main()
