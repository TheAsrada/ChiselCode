from ledger_db import open_ledger

def post(opening, transfers):
    with open_ledger(opening) as conn:
        for _, source, target, amount in transfers:
            conn.execute("UPDATE accounts SET balance=balance-? WHERE name=?", (amount, source))
            conn.execute("UPDATE accounts SET balance=balance+? WHERE name=?", (amount, target))
        return {
            "balances": dict(conn.execute("SELECT name,balance FROM accounts")),
            "statuses": ["posted"] * len(transfers),
        }
