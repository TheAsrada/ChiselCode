import unittest
from solution import post

class PublicTest(unittest.TestCase):
    def test_example(self):
        self.assertEqual(post(*[{"a": 5, "b": 0}, [["t", "a", "b", 2]]]), {"balances": {"a": 3, "b": 2}, "statuses": ["posted"]})


if __name__ == "__main__":
    unittest.main()
