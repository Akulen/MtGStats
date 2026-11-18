/* ======================================================================
 *  Math Stuff
 * ==================================================================== */

/** @type {(arr: number[]) => number} */
export function sum(arr) {
    return arr.reduce((t, x) => t + x, 0);
}

/** @type {(x: number) => number} */
export function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}

export const MS2DAY = 1000 * 60 * 60 * 24;

/* --- Helper Math Functions for Beta Quantile ---
 * A lot of mathemagics
 */

/** @type {(z: number) => number} */
function logGamma(z) {
    const c = [676.5203681218851, -1259.139216722289, 771.3234287776531,
               -176.61502916214059, 12.507343278686905, -0.13857109526572012,
               9.98436957801957e-6, 1.5056327351493116e-7];
    if(z < 0.5)
        return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for(let i = 0; i < c.length; i++) x += c[i] / (z + i + 1);
    const t = z + c.length - 0.5;
    return Math.log(2*Math.PI) / 2 + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** @type {(x: number, a: number, b: number) => number} */
function incBetaContinuedFraction(x, a, b) {
    const maxIter = 100;
    const eps = 1e-12;
    const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;

    let c = 1, d = 1 - (a + b) * x / (a + 1);
    if(Math.abs(d) < eps) d = eps;
    d = 1 / d;
    let h = d;

    for(let m = 1; m <= maxIter; m++) {
        const m2 = 2 * m;
        // Even step
        let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < eps) d = eps;
        c = 1 + aa / c; if (Math.abs(c) < eps) c = eps;
        d = 1 / d; h *= d * c;

        // Odd step
        aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
        d = 1 + aa * d; if (Math.abs(d) < eps) d = eps;
        c = 1 + aa / c; if (Math.abs(c) < eps) c = eps;
        d = 1 / d; h *= d * c;

        if (Math.abs(d * c - 1) < eps) break;
    }
    return front * h;
}

/** @type {(x: number, a: number, b: number) => number} */
function incBeta(x, a, b) {
    if(x <= 0) return 0;
    if(x >= 1) return 1;
    if(b * x < (a + 1) * (1 - x)) return incBetaContinuedFraction(x, a, b);
    return 1 - incBetaContinuedFraction(1 - x, b, a);
}

// Inverts the Beta CDF using Halley's / Newton's method
/** @type {(p: number, a: number, b: number) => number} */
export function betaQuantile(p, a, b) {
    if(p <= 0) return 0;
    if(p >= 1) return 1;
    if(a <= 0 || b <= 0) return a / (a + b);

    let low = 0;
    let high = 1;
    // Initial guess via Normal Approximation (Wilson-Hilferty transformation)
    let x = a / (a + b);
    const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);

    for(let i = 0; i < 10; i++) {
        const err = incBeta(x, a, b) - p;
        if(Math.abs(err) < 1e-10) break;

        if (err < 0) low = x;
        else high = x;

        // Derivative (Beta PDF)
        const pdf = Math.exp(
            (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lbeta
        );

        const nextX = pdf > 0 ? x - err / pdf : (low + high) / 2;
        if (nextX <= low || nextX >= high) {
            x = (low + high) / 2;
        } else {
            x = nextX;
        }
    }
    return x;
}

/* ======================================================================
 *  Various Stuff
 * ==================================================================== */

/** @type {(p: number) => (v: number) => string} */
export function pct(p) {
    return v => `${(v * 100).toFixed(p)}%`;
}

/** @type {(date: Date) => string} */
export function dateToString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** @type {(url: string) => Promise<Record<string, any>>} */
export async function fetchJSON(url) {
    return fetch(url).then(res => {
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return res.json();
    });
}

/**
 * @typedef {Object} Event
 * @property {string[]} impacts
 * @property {string} date
 * @property {string} title
 **/

/**
 * @type {(
 *     event: Event,
 *     decks: string[] | string
 * ) => boolean}
 */
export function eventMatters(event, decks) {
    if(!Array.isArray(decks)) decks = [decks];
    return !event.impacts || event.impacts.some(deck => decks.includes(deck));
}

/**
 * @param {number} t - The time at which to estimate, as a timestamp
 * @param {{ t: number, w: number, l: number }[]} pts - All data points,
 *                                                      time (t) sorted
 * @param {number[]} eventTimes - The timestamps of relevant events
 * @param {number} reach - Time delta from which to ignore points
 * @param {number} sigma - Receptive field in ms
 * @param {number} a0 - Success prior
 * @param {number} b0 - Failure prior
 * @param {number} first - Amount of prefix points to ignore
 * @param {number} estimateT - Threshold of minimum data before dropping
 * @param {number} ci - Confidence interval quantile ((0.5, 1])
 * @param {number} gamma - Event discount
 * @param {number} k - prior
 * @returns {{ first: number, row: [
 *     number,
 *     string | number,
 *     string | number,
 *     string | number,
 *     number,
 *     number
 * ] }}
 */
export function betaEstimateAt(
    t, pts, eventTimes, reach, sigma, a0, b0, first=0, estimateT=0, ci=0.9,
    gamma=0.3, k=3
) {
    while(first < pts.length && pts[first].t < t - reach) first++;
    let W = a0, L = b0;
    for(let i = first; i < pts.length; i++) {
        const p = pts[i];
        if(p.t > t + reach) break;
        const delta = (t - p.t) / sigma;
        let wt = Math.exp(-0.5 * delta * delta);
        const lo = Math.min(p.t, t), hi = Math.max(p.t, t);
        // TODO: Optimize this to be amortized constant time
        for(const e of eventTimes) {
            if (e > lo && e <= hi) wt *= gamma;
        }
        W += wt * p.w;
        L += wt * p.l;
    }
    const eN = W + L - k;
    /**
     * @type [
     *     number,
     *     string | number,
     *     string | number,
     *     string | number,
     *     number,
     *     number
     *  ]
     */
    let row;

    if(eN >= estimateT) {
        const lo = betaQuantile((1 - ci) / 2, W, L);
        const hi = betaQuantile((1 + ci) / 2, W, L);

        row = [
            t,
            W / (W + L),
            lo,
            hi,
            eN,
            W / (W + L),
        ];
    }
    else
        row = [
            t, '-', '-', '-', eN, W / (W + L)
        ];
    return { first, row };
}

/* ======================================================================
 *  CHART: Win-rate
 * ==================================================================== */


export const KERNEL_CUTOFF = Math.sqrt(2 * Math.log(1e4));
export const DEFAULT_D = 30;

/**
 * @typedef {Record<string, number>} SCEntry
 **/

/**
 * @typedef {Record<string, Record<string, [number, number]>>} WLMatrix
 */

/**
 * @typedef {Object} EstimatedWR
 * @property {number} mean
 * @property {number} sd
 * @property {number} lo
 * @property {number} hi
 */

/**
 * @typedef {Object} SCData
 * @property {Event[]} events
 * @property {WLMatrix} estimates
 * @property {Record<string, SCEntry>} counts
 */

/**
 * @typedef {Record<string, {
 *     s: string | number,
 *     lo: string | number,
 *     hi: string | number,
 *     eN: string | number,
 * }>} SCReturn
 **/

/**
 * @param {string} A - the archetype whose overall win rate we want
 * @param {Record<string, { W: number, L: number }>} shareWL - share estimates
 * @param {WLMatrix} estimates - estimates[A][B] = [W, L]
 * @param {number} [ci=0.90] - Confidence interval quantile ((0.5, 1])
 * @param {number} [prior=3] - prior
 */
export function estimateWR(A, shareWL, estimates, ci=0.9, prior=3) {
    const names = Object.keys(shareWL);

    // Dirichlet: means from each (W, L), one shared concentration (median)
    const raw = names.map(B => shareWL[B].W / (shareWL[B].W + shareWL[B].L));
    const tot = sum(raw);
    const m = raw.map(x => x / tot);
    const ks = names.map(B => shareWL[B].W + shareWL[B].L)
                    .sort((a, b) => a - b);
    const a0 = ks[Math.floor(ks.length / 2)];

    const known = Object.entries(estimates[A] ?? {}).filter(([B]) => B !== A);
    const totW = sum(known.map(([, [W]]) => W));
    const totN = sum(known.map(([, [W, L]]) => W + L));
    const avgWR = totN > 0 ? totW / totN : 0.5;
    const priorMu = avgWR;
    const priorV = avgWR * (1 - avgWR) / (prior + 1);

    let mean = 0, sumMuSq = 0, term1 = 0;
    names.forEach((B, i) => {
        let mu, v;
        if (B === A) {                       // mirror matchup
            mu = 0.5; v = 0;
        } else if (estimates[A]?.[B]) {
            const [W, L] = estimates[A][B];
            mu = W / (W + L);
            v = mu * (1 - mu) / (W + L + 1);
        } else {                             // no data: fall back to the prior
            mu = priorMu; v = priorV;
        }
        mean += m[i] * mu;
        sumMuSq += m[i] * mu * mu;
        term1 += (m[i] * (1 - m[i]) / (a0 + 1) + m[i] * m[i]) * v;
    });
    const variance = term1 + (sumMuSq - mean * mean) / (a0 + 1);

    if (!(variance > 0)) return { mean, sd: 0, lo: mean, hi: mean };
    const k = mean * (1 - mean) / variance - 1;
    const lo = betaQuantile((1 - ci) / 2, mean * k, (1 - mean) * k);
    const hi = betaQuantile((1 + ci) / 2, mean * k, (1 - mean) * k);
    return { mean, sd: Math.sqrt(variance), lo, hi };
}

/**
 * @param {string} dataFile - URL to a JSON file
 * @param {(
 *     shares: SCReturn, estimates: Record<string, EstimatedWR>
 * ) => void} callback
 * @returns {void}
 */
export function getSC(dataFile, callback) {
    fetchJSON(dataFile).then(raw_data => {
        if(raw_data.events === undefined) {
            console.log("JSON data missing 'events' field");
            return {};
        }
        if(raw_data.estimates === undefined) {
            console.log("JSON data missing 'estimates' field");
            return {};
        }
        if(raw_data.counts === undefined) {
            console.log("JSON data missing 'counts' field");
            return {};
        }
        const data = /** @type {SCData} */ (raw_data);
        const date = new Date();
        const daysUntilFriday = (7 - date.getDay() + 5) % 7;
        date.setDate(date.getDate() + daysUntilFriday);
        const t = Date.parse(dateToString(date));
        const totals = Object.fromEntries(Object.entries(data.counts).map(
            ([date, counts]) => [date, sum(Object.values(counts))]
        ));
        const subarchetypes = Object.values(data.counts).at(-1) || {};
        // TODO: Couple with makeWRControls
        const sigma = DEFAULT_D * MS2DAY;
        const reach = KERNEL_CUTOFF * sigma;
        const k = 3;
        let totalShares = 0;
        const shares = Object.keys(subarchetypes).map(sa => {
            const eventTimes = data.events.filter(e => eventMatters(e,sa))
                                          .map(e => Date.parse(e.date));
            const pts = Object.entries(data.counts).map(([date, cnts]) =>
                ({
                    t: Date.parse(date), w: cnts[sa], l: totals[date] - cnts[sa]
                })
            );
            const avgWR = sum(pts.map(p => p.w)) / sum(pts.map(p => p.w + p.l));
            const a0 = avgWR * k, b0 = (1 - avgWR) * k;
            const { row: [, s, lo, hi, eN,]} = betaEstimateAt(
                t, pts, eventTimes, reach, sigma, a0, b0, 0, 0, 0.95, 0.3, k
            );
            var W = 0;
            var L = 0;
            if(typeof s === 'number') {
                totalShares += s;
                W = s * (eN + k);
                L = eN + k - W;
            }
            return ({sa, v: { s, lo, hi, eN, W, L }});
        });

        callback(
            Object.fromEntries(shares.map(({sa, v: { s, lo, hi, eN, }}) =>
                [sa, {
                    s:  typeof s  === 'number' ? s  / totalShares : s,
                    lo: typeof lo === 'number' ? lo / totalShares : lo,
                    hi: typeof hi === 'number' ? hi / totalShares : hi,
                    eN: typeof eN === 'number' ? eN / totalShares : eN,
                }]
            )),
            Object.fromEntries(Object.keys(subarchetypes).map(sa =>
                [sa, estimateWR(
                    sa,
                    Object.fromEntries(shares.map(({sa, v: { W, L, }}) =>
                        [sa, { W, L }]
                    )),
                    data.estimates,
                    0.9,
                    3
                )]
            ))
        );
    })
}
