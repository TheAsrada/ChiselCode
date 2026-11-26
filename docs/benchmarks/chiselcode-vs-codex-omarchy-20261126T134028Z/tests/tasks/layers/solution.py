from copy import deepcopy

def resolve(defaults, layers, env):
    result = deepcopy(defaults)
    for layer in layers:
        result.update(layer)
    return result
