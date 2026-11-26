import unittest
from solution import resolve

class PublicTest(unittest.TestCase):
    def test_example(self):
        self.assertEqual(resolve(*[{"x": 2}, [{"x": 3}], {}]), {"x": 3})


if __name__ == "__main__":
    unittest.main()
