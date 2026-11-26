import json

def replay(lines, watermark):
    state = {}
    for line in lines:
        if not line.strip():
            continue
        event = json.loads(line)
        if event["op"] == "set":
            state[event["key"]] = event["value"]
        else:
            state.pop(event["key"], None)
        watermark = max(watermark, event["seq"])
    return {"state": state, "issues": [], "watermark": watermark}
