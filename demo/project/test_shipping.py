import unittest
from decimal import Decimal
from shipping import shipping_cost


class ShippingTests(unittest.TestCase):
    def test_below_threshold(self):
        self.assertEqual(shipping_cost("49.99"), Decimal("4.99"))

    def test_at_threshold(self):
        self.assertEqual(shipping_cost("50.00"), Decimal("0.00"))

    def test_above_threshold(self):
        self.assertEqual(shipping_cost("50.01"), Decimal("0.00"))


if __name__ == "__main__":
    unittest.main()
