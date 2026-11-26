import sqlite3

def open_ledger(opening):
    connection = sqlite3.connect(":memory:")
    with connection:
        connection.execute("CREATE TABLE accounts(name TEXT PRIMARY KEY, balance INTEGER NOT NULL)")
        connection.executemany("INSERT INTO accounts VALUES (?, ?)", opening.items())
    return connection
