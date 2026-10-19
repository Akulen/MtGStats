/* ======================================================================
 *  Shared helpers
 * ==================================================================== */
const MS2DAY = 1000 * 60 * 60 * 24;
const CI_PER2Z = {90: 1.645};

function sum(arr) {
    return arr.reduce((t, x) => t + x, 0);
}
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}
function eventMatters(event, decks) {
    if(!Array.isArray(decks)) decks = [decks];
    return !event.impacts || event.impacts.some(deck => decks.includes(deck));
}

async function fetchJSON(url) {
    return fetch(url).then(res => {
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return res.json();
    });
}

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

function betaEstimate(
    name, opp, data, events, d=DEFAULT_D, estimateT=0, z=1.645, gamma=0.3, k=3
) {
    const pts = data.map(([date, [w, l]]) => ({ t: Date.parse(date), w, l }));
    const avgWR = sum(pts.map(p => p.w)) / sum(pts.map(p => p.w + p.l));
    const a0 = avgWR * k, b0 = (1 - avgWR) * k;
    const sigma = d * MS2DAY;
    const reach = KERNEL_CUTOFF * sigma;
    const eventTimes = events.filter(e => eventMatters(e, [name, opp]))
                             .map(e => Date.parse(e.date));

    const rows = [];
    let first = 0;
    for(let t = pts[0].t; t <= pts[pts.length - 1].t; t += MS2DAY) {
        while(first < pts.length && pts[first].t < t - reach) first++;
        let W = a0, L = b0;
        for(let i = first; i < pts.length; i++) {
            const p = pts[i];
            if(p.t > t + reach) break;
            const delta = (t - p.t) / sigma;
            let wt = Math.exp(-0.5 * delta * delta);
            const lo = Math.min(p.t, t), hi = Math.max(p.t, t);
            for(const e of eventTimes) {
                if (e > lo && e <= hi) wt *= gamma;
            }
            W += wt * p.w;
            L += wt * p.l;
        }
        const se = Math.sqrt(1 / W + 0.5 / (W * W) + 1 / L + 0.5 / (L * L));
        const c = Math.log(W / L);
        const eN = W + L - k;
        if(eN >= estimateT)
            rows.push([
                t,
                W / (W + L),
                sigmoid(c - z * se),
                sigmoid(c + z * se),
                eN,
                W / (W + L),
            ]);
        else
            rows.push([
                t, '-', '-', '-', eN, W / (W + L)
            ]);
    }
    return rows;
}

/* Make the yaxis symmetric around 50%, with 1% snapped padding */
function yRange(series, selected) {
    if(selected !== undefined && !selected) return 0;
    const values = series.filter(
        x => typeof x === 'number' && !Number.isNaN(x)
    );
    const min = Math.min(...values);
    const max = Math.max(...values);
    const dist = Math.max(0.5 - min, max - 0.5);
    const half = Math.min(0.5, Math.ceil(dist * 1.05 / 0.05) * 0.05);
    return half;
}

const HOVER_STYLES = {
    normal: { width: 3, lineOpacity: 1, area: 0.2, z: 2 },
    on:     { width: 6, lineOpacity: 1, area: 0.5, z: 3 },
    off:    { width: 1, lineOpacity: 0.3, area: 0.03, z: 2 },
};
const CI_PER = 90;

function prepareSeries(
    data, palette, mode, selected, betaWindow=DEFAULT_D, estimateT=0
) {
    const series = [];
    const names = [];
    const totals = {};
    const ranges = [];
    Object.entries(data.entries).toReversed().forEach(([opp, datum], i) => {
        const entries = Object.entries(datum[mode]);
        const rows = betaEstimate(
            data.subarchetype,
            opp,
            entries,
            data.events,
            betaWindow,
            estimateT,
            CI_PER2Z[CI_PER]
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
            data: rows.map(r => [r[0], r[3] - r[2]]),
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
    input.min = MIN_D;
    input.max = MAX_D;
    input.step = 1;
    input.value = win;
    const output = document.createElement('output');
    output.textContent = `${win} days`;
    input.addEventListener('input', () => {
        output.textContent = `${input.value} days`;
        onWindow(Number(input.value));
    });
    label.append(caption, input, output);

    bar.append(seg, label);
    chartDom.parentNode.insertBefore(bar, chartDom);
    return bar;
}

export function makeWR(dataFile, chartDom, enableT=0, estimateT=0) {
    fetchJSON(dataFile).then(data => {
        const pct = p => (v => `${(v * 100).toFixed(p)}%`);
        const dateFmt = new Intl.DateTimeFormat(
            'en-IE', // TODO
            {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
            }
        );
        const title = `${data.subarchetype} - Win Rates`;
        var current = { series: [], names: [], totals: [] };
        var currentMode = 'match';
        var currentWindow = DEFAULT_D;
        var hovered = null;

        const selected = {}
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
                formatter: params => {
                    const rows = params
                        .filter(p => p.seriesId?.startsWith('wr:'))
                        .sort((a, b) => b.value[1] - a.value[1]);
                    if(!rows.length) return '';
                    const unit = `${currentMode}s`;
                    const cell = '1px 0 1px 10px;';

                    const date = document.createElement('div');
                    date.style.fontWeight = 600;
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
                        d_ci.style.opacity = 0.65;
                        d_ci.style.fontFamily = 'monospace';
                        if(wr !== '-')
                            d_ci.innerHTML = `[${pct(1)(lo)}-${pct(1)(hi)}]`;
                        const d_n = document.createElement('td');
                        d_n.style.padding = cell;
                        d_n.style.opacity = 0.65;
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
                    ci.style.opacity = 0.55;
                    ci.style.fontSize = '11px';
                    ci.style.marginTop = '4px';
                    ci.textContent =
                        `${pct(0)(CI_PER/100)} interval · n = weighted ${unit}
                         in the window`;
                    return [date, values, ci];
                }
            },
            legend: {
                type: 'scroll',
                width: '80%',
                bottom: 0,
                formatter: name => current.totals[name] !== undefined
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
                if(cache.size >= 16) cache.delete(cache.keys().next().value);
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
            onMode: mode => { currentMode = mode; refresh(); },
            onWindow: (() => {
                let frame = 0;
                return win => {
                    currentWindow = win;
                    cancelAnimationFrame(frame);
                    frame = requestAnimationFrame(refresh);
                };
            })(),
        });

        myChart.on('legendselectchanged', params => {
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
        });

        function styleHover(opp) {
            if(opp !== null && current.totals[opp] === undefined) return;
            if(opp === hovered) return;
            hovered = opp;
            myChart.setOption({
                // tooltip: { show: opp === null },
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
        myChart.on('mouseover', { componentType: 'series', seriesType: 'line' },
            params => {
                styleHover(params.seriesName);
            }
        );
        myChart.on('mouseout', { componentType: 'series', seriesType: 'line' },
            () => styleHover(null)
        );
        myChart.on('mouseover', { componentType: 'legend', },
            params => {
                if(params.componentType !== 'legend') return;
                styleHover(params.value);
            }
        );
        myChart.on('mouseout', { componentType: 'legend', },
            params => {
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

function getTodayString() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};


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
