"""A tiny shipping quote service for the live Git demo."""
from decimal import Decimal


def shipping_cost(subtotal):
    """Orders of $50 or more qualify for free shipping."""
    amount = Decimal(str(subtotal))
    if amount > Decimal("50"):
        return Decimal("0.00")
    return Decimal("4.99")
