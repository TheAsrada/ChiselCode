import unittest
from solution import dispatch

class PublicTest(unittest.TestCase):
    def test_example(self):
        self.assertEqual(dispatch(*[{"main": ["x"]}, [[2,"x","hi"]], 5]), [[2, "main", "x", "hi"]])


if __name__ == "__main__":
    unittest.main()
