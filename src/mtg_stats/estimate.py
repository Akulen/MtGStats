import math

from scipy.stats import beta

def betaEstimateAt(
    t, pts, event_times, reach, sigma, a0, b0, first=0, gamma=0.3
):
    while first < len(pts) and pts[first]['t'] < t - reach:
        first += 1
    W, L = a0, b0
    for p in pts:
        if p['t'] > t + reach: break
        delta = (t - p['t']) / sigma
        wt = math.exp(-0.5 * delta * delta)
        lo, hi = min(p['t'], t), max(p['t'], t)
        for e in event_times:
            if lo < e <= hi:
                wt *= gamma
        W += wt * p['w']
        L += wt * p['l']
    return W, L
