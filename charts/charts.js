if(typeof /** @type {any} */ (globalThis).echarts === 'undefined') {
    throw new Error("Module initialization failed: 'echarts' is not loaded on the global scope.");
}
/** @type {any} */
const echarts = /** @type {any} */ (globalThis).echarts;

/**
 * @typedef {Object} Event
 * @property {string[]} impacts
 * @property {string} date
 * @property {string} title
 **/

/**
 * @typedef {Object} WREntry
 * @property {Record<string, [w: number, l:number]>} match
 * @property {Record<string, [w: number, l:number]>} game
 **/

/**
 * @typedef {Object} WRData
 * @property {string} subarchetype
 * @property {Event[]} events
 * @property {Record<string, WREntry>} entries
 */

/**
 * @typedef {Record<string, number>} SCEntry
 **/

/**
 * @typedef {Object} SCData
 * @property {Event[]} events
 * @property {Record<string, SCEntry>} counts
 */

/** @typedef {'match' | 'game'} ModeStr */

/* ======================================================================
 *  Shared helpers
 * ==================================================================== */
const MS2DAY = 1000 * 60 * 60 * 24;

/** @type {(arr: number[]) => number} */
function sum(arr) {
    return arr.reduce((t, x) => t + x, 0);
}
/** @type {(x: number) => number} */
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}

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
function betaQuantile(p, a, b) {
    if(p <= 0) return 0;
    if(p >= 1) return 1;
    if(a <= 0 || b <= 0) return a / (a + b);

    // Initial guess via Normal Approximation (Wilson-Hilferty transformation)
    let x = a / (a + b);
    const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);

    for(let i = 0; i < 10; i++) {
        const err = incBeta(x, a, b) - p;
        if(Math.abs(err) < 1e-10) break;

        // Derivative (Beta PDF)
        const pdf = Math.exp(
            (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lbeta
        );
        if(pdf === 0) break;

        // Newton step with boundary safeguard
        const dx = err / pdf;
        x = x - dx;
        if(x <= 0) {
            x = 1e-12;
            break;
        }
        if(x >= 1) {
            x = 1 - 1e-12;
            break;
        }
    }
    return x;
}

/* ==================================================================== */

/** @type {(p: number) => (v: number) => string} */
export function pct(p) {
    return v => `${(v * 100).toFixed(p)}%`;
}
/** @type {(date: Date) => string} */
function dateToString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function getTodayString() {
    return dateToString(new Date());
};

/**
 * @type {(
 *     event: Event,
 *     decks: string[] | string
 * ) => boolean}
 */
function eventMatters(event, decks) {
    if(!Array.isArray(decks)) decks = [decks];
    return !event.impacts || event.impacts.some(deck => decks.includes(deck));
}
/** @type {(url: string) => Promise<Record<string, any>>} */
async function fetchJSON(url) {
    return fetch(url).then(res => {
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return res.json();
    });
}
/**
 * @type {(
 *     chartDom: HTMLDivElement,
 *     title: string,
 *     message: string
 * ) => void}
 */
function renderPlaceholder(chartDom, title, message) {
    const card = document.createElement('div');
    card.classList.add('mtg-chart-card');
    const heading = document.createElement('h3');
    heading.textContent = title;
    card.appendChild(heading);
    card.insertAdjacentHTML("beforeend", `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
             stroke="#268bd2" stroke-width="2" stroke-linecap="round"
             stroke-linejoin="round" style="margin-bottom:12px; opacity:0.8;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
    `);
    const content = document.createElement('span');
    content.textContent = message;
    card.append(content);
    chartDom.appendChild(card);
}

/* ======================================================================
 *  CHART: Win-rate
 * ==================================================================== */
/**
 * Gaussian-kernel weighted Beta estimate of the win rate at every day.
 * `data` is [[date, [wins, losses]], ...] sorted by date.
 * Returns rows of [timestamp, winRate, lower, upper, effectiveN].
 */


const KERNEL_CUTOFF = Math.sqrt(2 * Math.log(1e4));
const DEFAULT_D = 30;

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
 * @returns {{ first: number, row: (number | string)[] }}
 */
function betaEstimateAt(
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

/**
 * @param {string} name
 * @param {string} opp
 * @param {[string, [number, number]][]} data - All data points, time (t) sorted
 * @param {Event[]} events - All events
 * @param {number} d - Receptive field in days
 * @param {number} estimateT - Threshold of minimum data before dropping
 * @param {number} ci - Confidence Interval quantile ((0.5, 1])
 * @param {number} gamma - Event discount
 * @param {number} k - prior
 * @returns {(number | string)[][]}
 */
function betaEstimate(
    name, opp, data, events, d=DEFAULT_D, estimateT=0, ci=0.9, gamma=0.3, k=3
) {
    const pts = data.map(([date, [w, l]]) => ({ t: Date.parse(date), w, l }));
    const avgWR = sum(pts.map(p => p.w)) / sum(pts.map(p => p.w + p.l));
    const a0 = avgWR * k, b0 = (1 - avgWR) * k;
    const sigma = d * MS2DAY;
    const reach = KERNEL_CUTOFF * sigma;
    const eventTimes = events.filter(e => eventMatters(e, [name, opp]))
                             .map(e => Date.parse(e.date));

    const rows = [];
    let first = 0, row;
    for(let t = pts[0].t; t <= pts[pts.length - 1].t; t += MS2DAY) {
        ({ first, row } = betaEstimateAt(
            t, pts, eventTimes, reach, sigma, a0, b0, first, estimateT, ci,
            gamma, k
        ));
        rows.push(row);
    }
    return rows;
}

/**
 * @type {(series: (number | string)[], selected: boolean) => number}
 * Make the yaxis symmetric around 50%, with 1% snapped padding
 */
function yRange(series, selected) {
    if(selected !== undefined && !selected) return 0;
    const values = /** @type {number[]} */ (series.filter(
        x => typeof x === 'number' && !Number.isNaN(x)
    ));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const dist = Math.max(0.5 - min, max - 0.5);
    const half = Math.min(0.5, Math.ceil(dist * 1.05 / 0.05) * 0.05);
    return half;
}

const HOVER_STYLES = {
    normal: { width: 3, lineOpacity: 1, area: 0.05, z: 2 },
    on:     { width: 6, lineOpacity: 1, area: 0.3, z: 3 },
    off:    { width: 1, lineOpacity: 0.3, area: 0.03, z: 2 },
};
const CI = 0.9;

/**
 * @param {WRData} data
 * @param {string[]} palette
 * @param {ModeStr} mode
 * @param {Record<string, boolean>} selected
 * @param {number} betaWindow
 * @param {number} estimateT
 * @returns {{
 *     range: number,
 *     series: Object[],
 *     names: string[],
 *     totals: Record<string, number>
 * }}
 */
function prepareSeries(
    data, palette, mode, selected, betaWindow=DEFAULT_D, estimateT=0
) {
    const series = [];
    const names = /** @type string[] */ ([]);
    const totals = /** @type Record<string, number> */ ({});
    const ranges = /** @type number[] */ ([]);
    Object.entries(data.entries).toReversed().forEach(([opp, datum], i) => {
        const entries = Object.entries(datum[mode]);
        const rows = betaEstimate(
            data.subarchetype,
            opp,
            entries,
            data.events,
            betaWindow,
            estimateT,
            CI
        );
        const color = palette[i % palette.length];
        names.push(opp);
        totals[opp] = sum(entries.map(([, [w, l]]) => w + l));
        ranges.push(yRange(rows.map(r => r[1]), selected[opp]));
        series.push({
            id: `lo:${opp}`,
            type: 'line',
            name: `${opp}-lower`,
            data: rows.map(r => [r[0], r[2]]),
            lineStyle: { opacity: 0 },
            itemStyle: { color: 'transparent'},
            stack: `${opp}-confidence-band`,
            symbol: 'none',
            tooltip: { show: false },
        }, {
            id: `hi:${opp}`,
            type: 'line',
            name: `${opp}-upper`,
            data: rows.map(r => [
                r[0],
                (typeof r[2] === 'string' || typeof r[3] === 'string')
                    ? '-'
                    : r[3] - r[2]
            ]),
            lineStyle: { opacity: 0 },
            itemStyle: { color: 'transparent'},
            stack: `${opp}-confidence-band`,
            symbol: 'none',
            areaStyle: { color: color, opacity: HOVER_STYLES.normal.area },
            tooltip: { show: false },
        }, {
            id: `wr:${opp}`,
            type: 'line',
            name: opp,
            data: rows,
            triggerLineEvent: true,
            showSymbol: false,
            color: color,
            lineStyle: { width: HOVER_STYLES.normal.width },
            zlevel: HOVER_STYLES.normal.z
        });
    });

    const decks = [...names, data.subarchetype];
    const eventLines = data.events
        .filter(e => eventMatters(e, decks))
        .map(e => ({
            xAxis: Date.parse(e.date),
            label: { formatter: e.title }
        }))
    series.unshift({
        id: 'referenc-lines',
        type: 'line',
        data: [],
        silent: true,
        markLine: {
            silent: true,
            symbol: ['none', 'none'],
            lineStyle: { type: 'dashed', color: '#999999', },
            label: { rotate: -90, offset: [10, 0], align: 'left' },
            data: [{ yAxis: 0.5, label: { show: false }, }, ...eventLines],
        },
    })
    const range = Math.max(...ranges);
    return { series, names, totals, range };
}

const MAX_D = 60;
const MIN_D = 7;
/**
 * @type {(
 *     chartDom: HTMLDivElement,
 *     options: {
 *         mode: ModeStr,
 *         window: number,
 *         onMode: Function,
 *         onWindow: Function
 *     }
 * ) => HTMLDivElement}
 */
function makeWRControls(chartDom, { mode, window: win, onMode, onWindow }) {
    const bar = document.createElement('div');
    bar.className = 'mtg-controls';

    const seg = document.createElement('div');
    seg.className = 'mtg-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Count wins by');
    [
        ['match', 'Matches', '#268bd2'],
        ['game', 'Games', '#859900']
    ].forEach(([value, text, color]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = text;
        btn.style.setProperty('--c', color);
        btn.setAttribute('aria-pressed', String(value === mode));
        btn.addEventListener('click', () => {
            seg.querySelectorAll('button').forEach(
                b => { b.setAttribute('aria-pressed', String(b === btn)) }
            );
            onMode(value);
        });
        seg.appendChild(btn);
    });

    const label = document.createElement('label');
    label.className = 'mtg-slider';
    label.title =
        'Standard deviation of the Gaussian kernel that weights nearby matches';
    const caption = document.createElement('span');
    caption.textContent = 'Smoothing';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(MIN_D);
    input.max = String(MAX_D);
    input.step = String(1);
    input.value = String(win);
    const output = document.createElement('output');
    output.textContent = `${win} days`;
    input.addEventListener('input', () => {
        output.textContent = `${input.value} days`;
        onWindow(Number(input.value));
    });
    label.append(caption, input, output);

    bar.append(seg, label);
    if(chartDom.parentNode)
        chartDom.parentNode.insertBefore(bar, chartDom);
    else
        console.log(
            `Warning, controls couldn't be added. ChartDom didn't have any
             parent node`
        );
    return bar;
}


/**
 * @param {string} dataFile - URL to a JSON file
 * @param {HTMLDivElement} chartDom - The <div> element in which to make the
 *                                    chart
 * @param {number} enableT - Threshold amount of matches under which to disable
 *                           series by default
 * @param {number} estimateT - Threshold number of matches under which not to
 *                             draw estimated data point
 * @returns {void}
 */
export function makeWR(dataFile, chartDom, enableT=0, estimateT=0) {
    fetchJSON(dataFile).then(raw_data => {
        const dateFmt = new Intl.DateTimeFormat(
            'en-IE', // TODO
            {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
            }
        );
        if(raw_data.subarchetype === undefined) {
            console.log("JSON data missing 'subarchetype' field");
            return;
        }
        if(raw_data.events === undefined) {
            console.log("JSON data missing 'events' field");
            return;
        }
        if(raw_data.entries === undefined) {
            console.log("JSON data missing 'entries' field");
            return;
        }
        const data = /** @type {WRData} */ (raw_data);
        const title = `${data.subarchetype} - Win Rates`;
        /**
         * @type {{
         *     range: number,
         *     series: Object[],
         *     names: string[],
         *     totals: Record<string, number>
         * }}
         */
        var current;
        var currentMode = /** @type ModeStr */ ('match');
        var currentWindow = DEFAULT_D;
        var hovered = /** @type {string | null} */ (null);

        const selected = /** @type Record<string, boolean> */ ({});
        Object.entries(data.entries).forEach(([opp, datum]) => {
            if(
                sum(Object.entries(datum.match).map(([, [w, l]]) => w + l))
                < enableT
            ) {
                selected[opp] = false;
                selected[`${opp}-lower`] = false;
                selected[`${opp}-upper`] = false;
            }
        });

        const option = {
            useUTC: true,
            backgroundColor: 'transparent',
            title: {
                top: 10,
                left: 'center',
                textStyle: { fontSize: 18 },
                text: title,
            },
            xAxis: {
                type: 'time',
                min: 'dataMin',
                max: 'dataMax',
                axisLabel: { formatter: '{MMM} {yyyy}', hideOverlap: true },
            },
            yAxis: {
                type: 'value',
                axisLabel: { formatter: pct(0), hideOverlap: true },
            },
            tooltip: {
                trigger: 'axis',
                confine: true,
                formatter: (/** @type Record<string, any>[] */ params) => {
                    const rows = params
                        .filter(p => p.seriesId?.startsWith('wr:'))
                        .sort((a, b) => b.value[1] - a.value[1]);
                    if(!rows.length) return '';
                    const unit = `${currentMode}s`;
                    const cell = '1px 0 1px 10px;';

                    const date = document.createElement('div');
                    date.style.fontWeight = String(600);
                    date.style.marginBottom = '4px';
                    date.textContent = dateFmt.format(rows[0].value[0]);
                    const values = document.createElement('table');
                    values.style.borderCollapse = 'separate';
                    values.style.borderSpacing = '10px 0px';
                    rows.forEach(p => {
                        if(hovered && hovered !== p.seriesName)
                            return;
                        if(hovered && hovered === p.seriesName) {
                            const chartDom = myChart.getDom();
                            const tooltipDom = chartDom?.lastChild;
                            if(tooltipDom) {
                                if(!tooltipDom.id)
                                    tooltipDom.id = 'wr-chart-tooltip';
                                const sB = document.createElement('style');
                                sB.textContent = `#wr-chart-tooltip {
                                    border-color: ${p.color} !important;
                                }`;
                                date.appendChild(sB);
                            }
                        }
                        const [, wr, lo, hi, n, t_wr] = p.value;
                        const row = document.createElement('tr');
                        const d_name = document.createElement('td');
                        d_name.innerHTML = `${p.marker}${p.seriesName}`;
                        const d_wr = document.createElement('td');
                        d_wr.style.padding = cell;
                        d_wr.style.textAlign = 'right';
                        d_wr.style.fontFamily = 'monospace';
                        if(wr !== '-')
                            d_wr.innerHTML = `<b>${pct(1)(wr)}</b>`;
                        else
                            d_wr.innerHTML = `<b>${pct(1)(t_wr)}</b>`;
                        const d_ci = document.createElement('td');
                        d_ci.style.padding = cell;
                        d_ci.style.opacity = String(0.65);
                        d_ci.style.fontFamily = 'monospace';
                        if(wr !== '-')
                            d_ci.innerHTML = `[${pct(1)(lo)}-${pct(1)(hi)}]`;
                        const d_n = document.createElement('td');
                        d_n.style.padding = cell;
                        d_n.style.opacity = String(0.65);
                        d_n.style.textAlign = 'right';
                        d_n.style.fontFamily = 'monospace';
                        d_n.innerHTML =
                            `n≈${Math.round(n).toString().padStart(3)}`;
                        row.appendChild(d_name);
                        row.appendChild(d_wr);
                        row.appendChild(d_ci);
                        row.appendChild(d_n);
                        values.appendChild(row);
                    });
                    const ci = document.createElement('div');
                    ci.style.opacity = String(0.55);
                    ci.style.fontSize = '11px';
                    ci.style.marginTop = '4px';
                    ci.textContent =
                        `${pct(0)(CI)} interval · n = weighted ${unit}
                         in the window`;
                    return [date, values, ci];
                }
            },
            legend: {
                type: 'scroll',
                width: '80%',
                bottom: 0,
                formatter: (/** @type string */ name) =>
                    current.totals[name] !== undefined
                        ? `${name} (${current.totals[name]})`
                        : name,
                triggerEvent: true,
                selected: selected
            },
            series: [],
        };

        const myChart = echarts.init(chartDom, 'dark');
        myChart.setOption(option);
        const palette = myChart.getOption().color;

        const cache = new Map();
        /**
         * @type {(
         *     mode: ModeStr, win: number, force?: boolean
         * ) => {
         *     range: number,
         *     series: Object[], names: string[], totals: Record<string, number>
         * }}
         */
        function getSeries(mode, win, force=false) {
            if(force) cache.clear();
            const key = `${mode}|${win}`;
            let hit = cache.get(key);
            if(hit)
                cache.delete(key);
            else {
                hit = prepareSeries(
                    data, palette, mode, selected, win, estimateT
                );
                if(cache.size >= 16)
                    cache.delete(cache.keys().next().value);
            }
            cache.set(key, hit);
            return hit;
        }

        current = getSeries(currentMode, currentWindow);
        if(current.names.length === 0) {
            myChart.dispose();
            renderPlaceholder(chartDom, title, 'Not enough data available');
            return;
        }

        function refresh(force = false) {
            current = getSeries(currentMode, currentWindow, force);
            hovered = null;
            myChart.setOption({
                tooltip: { show: true },
                yAxis: { min: 0.5 - current.range, max: 0.5 + current.range },
                series: current.series,
                legend: { data: current.names },
            }, { replaceMerge: ['series'] });
        }
        refresh();

        makeWRControls(chartDom, {
            mode: currentMode,
            window: currentWindow,
            onMode: (/** @type ModeStr */ mode) => {
                currentMode = mode;
                refresh();
            },
            onWindow: (() => {
                let frame = 0;
                return (/** @type number */ win) => {
                    currentWindow = win;
                    cancelAnimationFrame(frame);
                    frame = requestAnimationFrame(() => refresh());
                };
            })(),
        });

        /** @type {(opp: string | null) => void} */
        function styleHover(opp) {
            if(opp !== null && current.totals[opp] === undefined) return;
            if(opp === hovered) return;
            hovered = opp;
            myChart.setOption({
                series: current.names.flatMap(name => {
                    const s = HOVER_STYLES[
                        opp === null ? 'normal' : name === opp ? 'on' : 'off'
                    ];
                    return [
                        { id: `wr:${name}`, z: s.z, lineStyle: {
                            width: s.width,
                            opacity: s.lineOpacity,
                        } },
                        { id: `hi:${name}`, areaStyle: { opacity: s.area } },
                    ];
                }),
            });
            if(opp !== null) myChart.dispatchAction({ type: 'hideTip' });
        }

        myChart.on('legendselectchanged',
            (
                /**
                /* @type {{ name: string, selected: Record<string, boolean> }}
                 */
                params
            ) => {
                const state = params.selected[params.name];
                const type = state
                    ? 'legendSelect'
                    : 'legendUnSelect';
                myChart.dispatchAction({ type, name: `${params.name}-lower` });
                myChart.dispatchAction({ type, name: `${params.name}-upper` });
                selected[params.name] = state;
                selected[`${params.name}-lower`] = state;
                selected[`${params.name}-upper`] = state;
                if(!state && hovered === params.name)
                    styleHover(null);
                refresh(true);
                if(state)
                    styleHover(params.name);
            }
        );
        myChart.on('mouseover', { componentType: 'series', seriesType: 'line' },
            (/** @type {{ seriesName: string }} */ params) => {
                styleHover(params.seriesName);
            }
        );
        myChart.on('mouseout', { componentType: 'series', seriesType: 'line' },
            () => styleHover(null)
        );
        myChart.on('mouseover', { componentType: 'legend', },
            (/** @type {{ componentType: string,value: string }} */ params) => {
                if(params.componentType !== 'legend') return;
                styleHover(params.value);
            }
        );
        myChart.on('mouseout', { componentType: 'legend', },
            (/** @type {{ componentType: string }} */ params) => {
                if(params.componentType !== 'legend') return;
                styleHover(null);
            }
        );

        function adapt() {
            const narrow = chartDom.clientWidth < 560;
            myChart.setOption({
                title: { textStyle: { fontSize: narrow ? 14 : 18 } },
                legend: { textStyle: { fontSize: narrow ? 11 : 12 } },
            });
        }
        new ResizeObserver(() => { myChart.resize(); adapt(); })
            .observe(chartDom);
        adapt();
    }).catch(err => {
        console.error(err);
        renderPlaceholder(chartDom, 'Win Rates', 'Could not load the data');
    });
}

/* ======================================================================
 *  CHART: Win-rate
 * ==================================================================== */


/**
 * @typedef {Record<string, {
 *     s: string | number,
 *     lo: string | number,
 *     hi: string | number,
 *     eN: string | number,
 * }>} SCReturn
 **/

/**
 * @param {string} dataFile - URL to a JSON file
 * @param {(shares: SCReturn) => void} callback
 * @returns {void}
 */
export function getSC(dataFile, callback) {
    fetchJSON(dataFile).then(raw_data => {
        if(raw_data.events === undefined) {
            console.log("JSON data missing 'events' field");
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
        const sigma = DEFAULT_D * MS2DAY; // TODO: Couple with makeWRControls
        const reach = KERNEL_CUTOFF * sigma;
        const k = 3;
        let totalShares = 0;
        const shares = Object.keys(subarchetypes).map(sa => {
            const eventTimes = data.events.filter(e => eventMatters(e, sa))
                                          .map(e => Date.parse(e.date));
            const pts = Object.entries(data.counts).map(([date, cnts]) =>
                ({
                    t: Date.parse(date), w: cnts[sa], l: totals[date] - cnts[sa]
                })
            );
            const avgWR = sum(pts.map(p => p.w)) / sum(pts.map(p => p.w + p.l));
            const a0 = avgWR * k, b0 = (1 - avgWR) * k;
            const { row: [, s, lo, hi, eN,]} = betaEstimateAt(
                t, pts, eventTimes, reach, sigma, a0, b0, 0, 0, 0.95
            );
            if(typeof s === 'number')
                totalShares += s;
            return ({sa, v: { s, lo, hi, eN }});
        });

        callback(Object.fromEntries(shares.map(({sa, v: { s, lo, hi, eN }}) =>
            [sa, {
                s:  typeof s  === 'number' ? s  / totalShares : s,
                lo: typeof lo === 'number' ? lo / totalShares : lo,
                hi: typeof hi === 'number' ? hi / totalShares : hi,
                eN: typeof eN === 'number' ? eN / totalShares : eN,
            }]
        )));
    })
}

/* ======================================================================
 *  CHART: Calendar
 * ==================================================================== */


export function makeCalendar(dataFile, chartDom) {
    const todayStr = getTodayString();
    const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
    const blockHeight = chartDom.offsetWidth * 120 / 900;
    fetch(dataFile).then(res => res.json()).then(data => {
        var option = {
            backgroundColor: 'transparent',
            title: {
                top: 30,
                left: 'center',
            },
            tooltip: {
                trigger: 'item',
                formatter: function (params) {
                    const [year, month, day] = params.data[0].split('-');
                    const dateObj = new Date(year, month - 1, day);
                    return `${formatter.format(dateObj)}: ${params.data[1]} matches`;
                }
            },
            visualMap: {
                min: 0,
                type: 'continuous',
                orient: 'horizontal',
                top: 18,
                left: 30,
                itemHeight: 140,
                inRange: {
                    color: [
                        "#50a3ba",
                        "#eac763",
                        "#d94e5d"
                    ]
                },
            },
            calendar: [],
            series: []
        };
        var n_years = Object.keys(data.entries).length;
        Object.entries(data.entries).toReversed().forEach(([year, data], i) => {
            option.calendar.push({
                top: (i + 5 / 8) * blockHeight,
                left: 30,
                right: 60,
                cellSize: ['auto', 13 * blockHeight / 120],
                range: year,
                itemStyle: {
                    borderWidth: 0.5
                },
                yearLabel: {
                    show: true,
                    position: 'right',
                },
                dayLabel: {
                    firstDay: 1,
                    fontFamily: 'Monospace',
                },
                monthLabel: {
                    show: i == n_years-1,
                    fontFamily: 'Monospace',
                    position: 'end',
                },
            });
            option.series.push({
                type: 'heatmap',
                coordinateSystem: 'calendar',
                calendarIndex: i,
                data: data
            });
        });
        chartDom.style.height = (n_years + 5 / 8) * blockHeight + 'px';
        option.visualMap.max = data.max;
        option.title.text = data.subarchetype + ' - #Matches Played';
        option.series.push({
            type: 'custom',
            coordinateSystem: 'calendar',
            calendarIndex: 0,
            renderItem: function (params, api) {
                const cellPoint = api.coord(todayStr);
                if (isNaN(cellPoint[0]) || isNaN(cellPoint[1])) return;

                const width = params.coordSys.cellWidth - 3;
                const height = params.coordSys.cellHeight - 3;

                return {
                    type: 'rect',
                    shape: {
                        x: cellPoint[0] - width / 2,
                        y: cellPoint[1] - height / 2,
                        width: width,
                        height: height
                    },
                    style: {
                        fill: 'none',
                        stroke: '#39FF14',
                        lineWidth: 2,
                        lineDash: [2, 2]
                    }
                };
            },
            data: [todayStr]
        });
        var myChart = echarts.init(chartDom, 'dark');
        myChart.setOption(option);
        window.addEventListener('resize', function() {
            myChart.resize();
        });
    });
}
