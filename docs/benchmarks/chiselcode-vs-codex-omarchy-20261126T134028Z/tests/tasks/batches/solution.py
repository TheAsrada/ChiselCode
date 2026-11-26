def apply_batches(stock, batches):
    result = dict(stock)
    for batch in batches:
        for sku, delta in batch["lines"]:
            result[sku] = result.get(sku, 0) + delta
    return {"stock": result, "statuses": ["applied"] * len(batches)}
