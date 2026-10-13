function sum(arr) {
    return arr.reduce((t, x) => t + x, 0);
}
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}
function betaEstimate(name, opp, data, events, d=30, gamma=0.3, k=3, z=1.645) {
    const nWins = sum(data.map(x => x[1][0]));
    const nLosses = sum(data.map(x => x[1][1]));
    const avgWR = nWins / (nWins + nLosses);
    const a0 = avgWR * k, b0 = (1 - avgWR) * k;
    d *= 24 * 60 * 60 * 1000; // day => ms
    var x = [], low = [], upp = [];
    var filterEvents = [];
    events.forEach(event => {
        var skip = true;
        if(event.impacts) {
            event.impacts.forEach(deck => {
                if(deck === name || deck == opp)
                    skip = false;
            });
        } else skip = false;
        if(!skip)
            filterEvents.push(event);
    });
    for(let t = Date.parse(data[0][0]); t <= Date.parse(data[data.length-1][0]); t += 24 * 60 * 60 * 1000) {
        let W = a0, L = b0;
        for (let i = 0; i < data.length; i++) {
            const s = Date.parse(data[i][0]);
            const delta = (t - s) / d;
            let wt = Math.exp(-0.5 * delta * delta);
            if (wt < 1e-4) continue;
            const lo = Math.min(s, t), hi = Math.max(s, t);
            for (const e of filterEvents) {
                const eDate = Date.parse(e.date);
                if (eDate > lo && eDate <= hi) {
                    wt *= gamma;
                }
            }
            W += wt * data[i][1][0];
            L += wt * data[i][1][1];
        }
        x.push([t, W / (W + L)]);
        const v = 1 / W + 0.5 / (W * W) + 1 / L + 0.5 / (L * L);
        const se = Math.sqrt(v), c = Math.log(W / L);
        low.push([t, sigmoid(c - z * se)]);
        upp.push([t, sigmoid(c + z * se) - sigmoid(c - z * se)]);
    }
    return [x, low, upp];
}
function yRange(min) {
    return function(value) {
        const distToMin = Math.abs(0.5 - value.min);
        const distToMax = Math.abs(0.5 - value.max);
        const maxDistance = Math.max(distToMin, distToMax);
        if(min)
            return 0.5 - maxDistance * 1.0; 
        else
            return 0.5 + maxDistance * 1.0; 
    }
}
const DEFAULT_D = 30;
function prepareSeries(data, palette, mode, betaWindow=DEFAULT_D) {
    var series = [
        {
            type: 'line',
            data: [],
            markLine: {
                symbol: ['none', 'none'],
                data: [
                    {
                        yAxis: 0.5,
                        lineStyle: {
                            type: 'dashed',
                            color: '#999999',
                        }
                    }
                ],
                label: { show: false },
                silent: true
            },
        }
    ];
    var names = [];
    var trueCount = 0;
    Object.entries(data.entries).toReversed().forEach(([opp, datum], i) => {
        var entries = Object.entries(datum[mode]);
        var [val, low, upp] = betaEstimate(data.subarchetype, opp, entries, data.events, d=betaWindow);
        const color = palette[trueCount % palette.length];
        names.push(opp);
        series.push({
            type: 'line',
            name: opp + '-lower',
            data: low,
            lineStyle: { opacity: 0 },
            itemStyle: { color: 'transparent'},
            stack: opp + 'confidence-band',
            symbol: 'none',
            tooltip: { show: false },
        });
        series.push({
            type: 'line',
            name: opp + '-upper',
            data: upp,
            lineStyle: { opacity: 0 },
            itemStyle: { color: 'transparent'},
            stack: opp + 'confidence-band',
            symbol: 'none',
            areaStyle: {
                color: color,
                opacity: 0.2
            },
            tooltip: { show: false },
            zlevel: 0
        });
        series.push({
            type: 'line',
            name: opp,
            data: val,
            triggerLineEvent: true,
            showSymbol: false,
            color: color,
            lineStyle: { width: 3 },
            zlevel: 0
        });
        trueCount++;
    });
    data.events.forEach(event => {
        var skip = true;
        if(event.impacts) {
            event.impacts.forEach(deck => {
                names.forEach(name => {
                    if(deck === name || deck == data.archetype)
                        skip = false;
                });
            });
        } else skip = false;
        if(skip) return;
        series.push({
            type: 'line',
            data: [],
            markLine: {
                symbol: ['none', 'none'],
                data: [{
                    xAxis: Date.parse(event.date),
                    lineStyle: {
                        type: 'dashed',
                        color: '#999999'
                    }
                }],
                label: {
                    formatter: event.title,
                    rotate: -90,
                    offset: [10, 0],
                    align: 'left'
                },
                silent: true
            }
        });
    });
    return [series, names];
}
function makeWR(dataFile, chartDom, bgColor='#1c1c23') {
    fetch(dataFile).then(res => res.json()).then(data => {
        const TRACK_WIDTH = 200;
        const MIN_OFFSET = 11;
        const MAX_D = 60;
        const MIN_D = 7;
        const START_SLIDER = (DEFAULT_D - MIN_D) / (MAX_D - MIN_D) * (TRACK_WIDTH - 2 * MIN_OFFSET) + MIN_OFFSET;
        var option = {
            backgroundColor: 'transparent',
            title: {
                top: 20,
                left: 'center',
            },
            xAxis: {
                type: 'time',
                min: 'dataMin',
                max: 'dataMax',
                axisLabel: {
                    formatter: '{MMM} {yyyy}',
                },
            },
            yAxis: {
                type: 'value',
                min: yRange(true),
                max: yRange(false),
                axisLabel: {
                    formatter: function (value) {
                        return Math.round(value * 100) + '%';
                    }
                },
            },
            tooltip: {
                trigger: 'axis',
                valueFormatter: function (value) {
                    return Math.round(value * 1000) / 10 + '%';
                }
            },
            legend: {
                type: 'plain'
            },
            graphic: [],
            series: [],
        };
        option.title.text = data.subarchetype + ' - Win Rates';
        var myChart = echarts.init(chartDom, 'dark');
        myChart.setOption(option);
        var currentMode = 'match';
        var [series, names] = prepareSeries(data, myChart.getOption().color, currentMode);
        if(names.length === 0) {
            myChart.dispose();
            chartDom.innerHTML = `
                <div style="
                         display: flex;
                         flex-direction: column;
                         align-items: center; 
                         justify-content: center; 
                         width: 100%; 
                         height: 100%; 
                         color: #93a1a1; 
                         font-family: sans-serif;
                ">
                    <h3 style="
                            font-family: sans-serif;
                            font-weight: bold;
                            line-height: 1.2;
                            color: #ffffff;
                    ">` + data.subarchetype + ` - Win Rates</h3>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#268bd2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 12px; opacity: 0.8;">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                    <span style="font-size: 16px; font-weight: 500; letter-spacing: 0.5px;">Not enough data available</span>
                </div>
                `;
            return;
        }
        var oldWindow = DEFAULT_D;
        myChart.setOption({
            series: series,
            legend: { data: names },
            graphic: [
                {
                    type: 'group',
                    right: 200,
                    top: 18,
                    children: [
                        {
                            type: 'text',
                            id: 'days-text',
                            z: 100,
                            top: -5,
                            right: 10,
                            style: {
                                text: DEFAULT_D + ' days',
                                fill: '#93a1a1',
                                fontFamily: 'sans-serif',
                                fontSize: 14,
                                fontWeight: '500',
                            }
                        },
                        {
                            type: 'rect',
                            top: -2,
                            shape: { width: TRACK_WIDTH, height: 4, r: 2 },
                            style: { fill: '#073642' }
                        },
                        {
                            type: 'rect',
                            id: 'active-slider',
                            top: -2,
                            shape: { width: START_SLIDER, height: 4, r: 2 },
                            style: { fill: '#268bd2' }
                        },
                        {
                            type: 'circle',
                            x: START_SLIDER,
                            y: 0,
                            shape: { r: 8 },
                            style: {
                                fill: '#fdf6e3',
                                stroke: '#268bd2',
                                lineWidth: 3,
                                shadowBlur: 6,
                                shadowColor: 'rgba(38, 139, 210, 0.4)',
                                shadowOffsetX: 0,
                                shadowOffsetY: 2
                            },
                            draggable: 'horizontal',

                            ondrag: function () {
                                if (this.x < MIN_OFFSET) this.x = MIN_OFFSET;
                                if (this.x > TRACK_WIDTH - MIN_OFFSET) this.x = TRACK_WIDTH - MIN_OFFSET;

                                let betaWindow = (this.x - MIN_OFFSET) / (TRACK_WIDTH - 2 * MIN_OFFSET);
                                betaWindow = Math.round(betaWindow * (MAX_D - MIN_D) + MIN_D);

                                if(betaWindow == oldWindow) return;
                                oldWindow = betaWindow;
                                var [newSeries, names] = prepareSeries(data, myChart.getOption().color, currentMode, betaWindow);
                                series = newSeries;
                                myChart.setOption({
                                    series: series,
                                    graphic: [
                                        {
                                            id: 'active-slider',
                                            shape: {
                                                width: this.x
                                            }
                                        },
                                        {
                                            id: 'days-text',
                                            style: {
                                                text: betaWindow + ' days'
                                            }
                                        },
                                    ]
                                });
                            }
                        }
                    ]
                },
                {
                    type: 'group',
                    id: 'toggleBtnGroup',
                    left: 250,
                    top: 15,
                    width: 140,
                    height: 35,
                    bounding: 'raw',
                    draggable: false,
                    children: [
                        {
                            type: 'rect',
                            id: 'btnRect',
                            shape: {
                                width: 140,
                                height: 35,
                                r: 4
                            },
                            style: {
                                fill: '#268bd2',
                                shadowBlur: 5,
                                shadowOffsetX: 2,
                                shadowOffsetY: 2,
                                shadowColor: 'rgba(0,0,0,0.2)'
                            }
                        },
                        {
                            type: 'text',
                            id: 'btnText',
                            left: 'center',
                            top: 'center',
                            style: {
                                fill: '#fdf6e3',
                                text: 'Mode: Match',
                                fontFamily: 'sans-serif',
                                fontSize: 14,
                                fontWeight: '500',
                            }
                        }
                    ],
                    onclick: function () {
                        var graphic;
                        if (currentMode === 'match') {
                            currentMode = 'game';

                            graphic = [
                                { id: 'btnRect', style: { fill: '#859900' } },
                                { id: 'btnText', style: { text: 'Mode: Game' } }
                            ];
                        } else {
                            currentMode = 'match';

                            graphic = [
                                { id: 'btnRect', style: { fill: '#268bd2' } },
                                { id: 'btnText', style: { text: 'Mode: Match' } }
                            ];
                        }
                        var [newSeries, names] = prepareSeries(data, myChart.getOption().color, currentMode, oldWindow);
                        series = newSeries;
                        myChart.setOption({
                            series: series,
                            legend: { data: names },
                            graphic: graphic
                        });
                    }
                }
            ]
        });
        myChart.on('legendselectchanged', function (params) {
            const mainSeriesName = params.name;
            const isSelected = params.selected[mainSeriesName];

            const actionType = isSelected ? 'legendSelect' : 'legendUnSelect';

            myChart.dispatchAction({
                type: actionType,
                name: `${mainSeriesName}-lower`
            });

            myChart.dispatchAction({
                type: actionType,
                name: `${mainSeriesName}-upper`
            });
        });
        myChart.on('mouseover', { componentType: 'series', seriesType: 'line' }, function (params) {
            if(params.componentType !== 'series') return;
            const hoveredName = params.seriesName;
            const allSeries = myChart.getOption().series;
            allSeries.map(serie => {
                if(!serie.name) return serie;
                if(serie.name === hoveredName || serie.name.startsWith(hoveredName + '-')) {
                    serie.lineStyle.width = 10;
                    serie.zlevel = 1;
                    if(serie.areaStyle)
                        serie.areaStyle.opacity = 0.5;
                    return serie;
                } else {
                    serie.lineStyle.width = 1;
                    if(serie.areaStyle)
                        serie.areaStyle.opacity = 0.03;
                    return serie;
                }
                return {}
            });
            myChart.setOption({
                series: allSeries,
                tooltip: { show: false }
            });
        });
        myChart.on('mouseout', { componentType: 'series', seriesType: 'line' }, function (params) {
            if(params.componentType !== 'series') return;
            myChart.setOption({
                series: series,
                tooltip: { show: true }
            });
        });
        window.addEventListener('resize', function() {
            myChart.resize();
        });
    });
}

function getTodayString() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

function makeCalendar(dataFile, chartDom, bgColor='#1c1c23') {
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
