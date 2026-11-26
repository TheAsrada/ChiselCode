def dispatch(routes, events, cooldown):
    out = []
    for time, tag, message in events:
        for channel, tags in routes.items():
            if tag in tags:
                out.append([time, channel, tag, message])
    return out
