def schedule(jobs):
    return {"waves": [sorted(jobs)] if jobs else [], "blocked": []}
