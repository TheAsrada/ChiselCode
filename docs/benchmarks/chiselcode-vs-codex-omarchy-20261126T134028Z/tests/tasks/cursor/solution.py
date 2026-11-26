def page(rows, limit, after, team):
    selected = sorted(rows, key=lambda row: -row["score"])
    return {"rows": selected[:limit], "next": None}
