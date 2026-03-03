const uPlot = require('uplot');
const fs = require('fs');
const { ipcRenderer } = require('electron');
const flatpickr = require('flatpickr');

let chart, columns = [], uData = [], normData = [];
let currentMode = 'zoom', currentScaleMode = 'Linear'; 
let dataMinTime, dataMaxTime;
let currentXMin = null, currentXMax = null;
let fpStart, fpEnd;
let diffPoints = [];
let isDualY = false;

const LIN_THRESH = 1e-12; 

function symlog(v) {
    return Math.asinh(v / LIN_THRESH);
}

function invSymlog(v) {
    return Math.sinh(v) * LIN_THRESH;
}

function switchMode(mode) {
    if (chart) { 
        currentXMin = chart.scales.x.min; 
        currentXMax = chart.scales.x.max; 
    }
    currentMode = mode;

    const modeButtons = {
        'zoom': 'zoomModeBtn',
        'pan': 'panModeBtn',
        'diff': 'diffModeBtn'
    };

    Object.keys(modeButtons).forEach(key => {
        const btn = document.getElementById(modeButtons[key]);
        if (btn) {
            if (key === mode) {
                btn.style.background = '#e67e22'; 
            } else {
                btn.style.background = '#2980b9';
            }
        }
    });

    if (mode === 'diff') { 
        diffPoints = []; 
        document.getElementById('pinned-data').innerHTML = "<b>Diff Mode:</b> Click two points on chart."; 
    }
    if (chart) renderChart();
}

const tooltip = document.createElement("div");
tooltip.className = "u-tooltip";
tooltip.style = "display:none; position:absolute; background:rgba(255,255,255,0.95); border:2px solid #34495e; border-radius:4px; padding:10px; pointer-events:none; z-index:100; font-size:12px; color:#333; box-shadow:3px 3px 10px rgba(0,0,0,0.3);";
document.body.appendChild(tooltip);

window.onload = () => {
    switchMode('zoom');
    window.addEventListener("resize", () => {
        if (chart) {
            chart.setSize({
                width: document.getElementById('chart-area').offsetWidth,
                height: document.getElementById('chart-area').offsetHeight
            });
        }
    });
};

document.getElementById('loadBtn').onclick = async () => {
    const filePath = await ipcRenderer.invoke('open-file');
    if (!filePath) return;
    const status = document.getElementById('status');
    status.innerText = "Initializing...";
    
    if (chart) { chart.destroy(); chart = null; }
    uData = []; normData = []; currentXMin = null; currentXMax = null;

    setTimeout(() => loadHugeFile(filePath, status), 50);
};

async function loadHugeFile(filePath, status) {
    const stats = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    let rowCount = 0, leftover = '';
    let lastValues; 

    stream.on('data', (chunk) => {
        const text = leftover + chunk;
        const lines = text.split(/\r?\n/);
        leftover = lines.pop();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cells = line.split(',');
            
            if (rowCount === 0) {
                columns = cells.map(c => c.trim());
                uData = columns.map(() => []);
                lastValues = new Float64Array(columns.length).fill(0);
                rowCount++;
                continue;
            }

            const timeVal = Date.parse(cells[0]) / 1000;
            if (isNaN(timeVal)) continue;

            uData[0].push(timeVal);
            for (let j = 1; j < columns.length; j++) {
                const rawVal = cells[j] ? cells[j].trim() : "";
                if (rawVal === "") {
                    uData[j].push(lastValues[j]);
                } else {
                    const parsed = parseFloat(rawVal);
                    if (isNaN(parsed)) {
                        uData[j].push(lastValues[j]);
                    } else {
                        uData[j].push(parsed);
                        lastValues[j] = parsed;
                    }
                }
            }
            rowCount++;
        }
        const pct = Math.round((stream.bytesRead / stats.size) * 100);
        status.innerText = `Loading.. (${pct}%)`;
    });

    stream.on('end', () => {
        for (let i = 0; i < uData.length; i++) {
            uData[i] = new Float64Array(uData[i]);
        }
        dataMinTime = uData[0][0];
        dataMaxTime = uData[0][uData[0].length - 1];
        
        initDatePickers(dataMinTime, dataMaxTime);
        fpStart.setDate(new Date(dataMinTime * 1000));
        fpEnd.setDate(new Date(dataMaxTime * 1000));
        
        createSidebar(); 
        renderChart();
        status.innerText = `Done: ${(uData[0].length).toLocaleString()} rows loaded.`;
    });
}

function renderChart() {
    const container = document.getElementById('chart-area');
    const overlayLegend = document.getElementById('overlay-legend'); // 실시간 범례 엘리먼트
    if (!container || !uData[0] || uData[0].length === 0) return;
    if (chart) chart.destroy();
    container.innerHTML = '';

    const isSymlog = currentScaleMode === 'log';
    const isNorm = currentScaleMode === 'norm';

    let activeData = uData;
    if (isNorm) {
        if (normData.length === 0) prepareNormalizedData();
        activeData = normData;
    } else if (isSymlog) {
        activeData = uData.map((series, i) => i === 0 ? series : series.map(v => symlog(v)));
    }

    const opts = {
        width: container.offsetWidth - 20,
        height: container.offsetHeight - 20,
        legend: { show: false },
        padding: [10, 20, 0, 10],
        cursor: { 
            drag: { setScale: currentMode === 'zoom', x: currentMode === 'zoom', y: false },
            points: { size: 12, fill: (u, si) => u.series[si].stroke + "66", stroke: (u, si) => u.series[si].stroke, width: 2 },
            focus: { prox: 50 }, 
            dist: (u, seriesIdx, dataIdx, x, y) => {
                let d = u.data[seriesIdx];
                let dx = u.valToPos(u.data[0][dataIdx], 'x') - x;
                let dy = u.valToPos(d[dataIdx], 'y') - y;
                return Math.sqrt(dx * dx + dy * dy);
            }
        },
        hooks: {
            setCursor: [u => {
                const { left, top, idx } = u.cursor;
                // 커서가 차트 영역을 벗어나면 숨김
                if (idx == null || left < 0) { 
                    tooltip.style.display = "none"; 
                    overlayLegend.style.display = "none";
                    return; 
                }

                const timeStr = uPlot.fmtDate("{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}")(new Date(uData[0][idx] * 1000));
                
                // 1. 움직이는 툴팁 (기존 유지)
                let tooltipContent = `<div style="font-weight:bold; border-bottom:1px solid #ccc; padding-bottom:4px; margin-bottom:6px;">${timeStr}</div>`;
                
                // 2. 우측 상단 실시간 범례 (새로 추가)
                let legendHtml = `<div class="ol-time">${timeStr}</div>`;
                let hasActiveSeries = false;

                columns.slice(1).forEach((name, i) => {
                    if (u.series[i + 1].show) {
                        hasActiveSeries = true;
                        const val = uData[i+1][idx];
                        const formattedVal = val === 0 ? "0e0" : val.toExponential(4).replace('+', '');
                        
                        // 툴팁용 HTML
                        tooltipContent += `<div style="color:${u.series[i + 1].stroke}; font-weight:500;">● ${name}: ${formattedVal}</div>`;
                        
                        // 우측 상단 범례용 HTML
                        legendHtml += `
                            <div class="ol-item">
                                <div class="ol-dot" style="background:${u.series[i + 1].stroke}"></div>
                                <span class="ol-label">${name}:</span>
                                <span class="ol-value">${formattedVal}</span>
                            </div>`;
                    }
                });

                // 표시할 데이터가 있을 때만 보여줌
                if (hasActiveSeries) {
                    overlayLegend.style.display = "block";
                    overlayLegend.innerHTML = legendHtml;

                    tooltip.style.display = "block";
                    tooltip.innerHTML = tooltipContent;
                    const bBox = container.getBoundingClientRect();
                    let xPos = left + bBox.left + 25;
                    if (xPos + 200 > window.innerWidth) xPos = left + bBox.left - 210;
                    tooltip.style.left = xPos + "px";
                    tooltip.style.top = (top + bBox.top + 25) + "px";
                } else {
                    overlayLegend.style.display = "none";
                    tooltip.style.display = "none";
                }
            }],
            init: [u => {
                u.over.addEventListener("mousedown", e => {
                    if (e.button !== 0) return; 
                    const idx = u.cursor.idx;
                    if (idx != null) {
                        let html = `<span style="background: #34495e; color: white; padding: 2px 10px; border-radius: 4px; margin-right: 15px; font-weight: bold; font-size: 13px;">
                                        ${uPlot.fmtDate("{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}")(new Date(uData[0][idx] * 1000))}
                                    </span>`;
                        columns.slice(1).forEach((name, i) => {
                            if (u.series[i + 1].show) {
                                const val = uData[i+1][idx];
                                const rawExpVal = val === 0 ? "0e0" : val.toExponential().replace('+', '');
                                html += `<span style="display: inline-block; margin-right: 18px; padding: 3px 0; border-bottom: 2px solid ${u.series[i+1].stroke};">
                                            <b style="color: #444; font-size: 12px;">${name}:</b> 
                                            <span style="color: ${u.series[i+1].stroke}; font-family: 'Consolas', 'Courier New', monospace; font-weight: bold; font-size: 13px; margin-left: 4px;">${rawExpVal}</span>
                                         </span>`;
                            }
                        });
                        document.getElementById('pinned-data').innerHTML = html;
                    }
                   if (currentMode === 'diff') {
                        const point = { time: uData[0][idx], vals: columns.slice(1).map((_, i) => uData[i+1][idx]) };
                        diffPoints.push(point);
                        if (diffPoints.length > 2) diffPoints.shift();
                        updateDiffDisplay();
                    }
                });
            }]
        },
        scales: {
            x: { time: true, min: currentXMin || dataMinTime, max: currentXMax || dataMaxTime },
            y: { auto: true },
            y2: { auto: true }
        },
        series: [
            { label: "Time" },
            ...columns.slice(1).map((name, i) => {
                const isChecked = document.getElementById(`ch-${i}`)?.checked || false;
                let scaleKey = 'y';
                if (isDualY && isChecked) {
                    const checkedBefore = Array.from(document.querySelectorAll('.col-ch'))
                                               .slice(0, i)
                                               .filter(c => c.checked).length;
                    scaleKey = (checkedBefore === 0) ? 'y' : 'y2';
                }

                return {
                    label: name,
                    show: isChecked,
                    stroke: `hsl(${(i * 137.5) % 360}, 70%, 50%)`,
                    width: 1.5,
                    scale: scaleKey 
                };
            })
        ],
        axes: [
            { 
                space: 60, 
                values: [[3600*24*365, "{YYYY}"], [3600*24, "{MM}-{DD}"], [3600, "{HH}:{mm}"], [1, "{HH}:{mm}:{ss}"]] 
            },
            { 
                scale: 'y',
                size: 90, 
                stroke: isDualY ? "#2980b9" : "#333", 
                values: (u, vals) => vals.map(v => {
                    const realVal = isSymlog ? invSymlog(v) : v;
                    return isNorm ? v.toFixed(2) : realVal.toExponential(2).replace('+', '');
                })
            },
            {
                show: isDualY,
                scale: 'y2',
                side: 1,
                grid: { show: false },
                size: 90,
                stroke: "#e67e22",
                values: (u, vals) => vals.map(v => {
                    const realVal = isSymlog ? invSymlog(v) : v;
                    return isNorm ? v.toFixed(2) : realVal.toExponential(2).replace('+', '');
                })
            }
        ],
        plugins: [wheelZoomPlugin(), panPlugin(), contextMenuPlugin()]
    };

    chart = new uPlot(opts, activeData, container);
}

function updateDiffDisplay() {
    const cont = document.getElementById('pinned-data');
    if (diffPoints.length < 1) return;

    let html = `<div style="display:flex; gap:20px; align-items:center; height:100%;">`;
    
    diffPoints.forEach((p, i) => {
        const date = uPlot.fmtDate("{HH}:{mm}:{ss}")(new Date(p.time * 1000));
        html += `<div style="border:1px solid #ccc; padding:8px; border-radius:4px; font-size:12px;">
                    <b style="color:#2980b9;">P${i+1} (${date})</b><br>`;
        p.vals.forEach((v, si) => {
            if (chart.series[si+1].show) {
                html += `<div style="font-family:monospace;">${v.toExponential(2)}</div>`;
            }
        });
        html += `</div>`;
    });

    if (diffPoints.length === 2) {
        html += `<div style="flex-grow:1; background:#ecf0f1; padding:8px; border-radius:4px; border-left:4px solid #e67e22;">
                    <b style="color:#e67e22;">Difference (P2 - P1)</b><br>`;
        columns.slice(1).forEach((name, i) => {
            if (chart.series[i+1].show) {
                const v1 = diffPoints[0].vals[i];
                const v2 = diffPoints[1].vals[i];
                const delta = v2 - v1;
                const percent = v1 !== 0 ? ((delta / Math.abs(v1)) * 100).toFixed(2) : "∞";
                
                html += `<div style="font-size:11px; margin-bottom:2px;">
                            <b>${name}:</b> ${delta.toExponential()} 
                            <span style="color:${delta >= 0 ? 'red' : 'blue'};">(${delta >= 0 ? '+' : ''}${percent}%)</span>
                         </div>`;
            }
        });
        html += `</div>`;
    }
    html += `</div>`;
    cont.innerHTML = html;
}

function prepareNormalizedData() {
    normData = [uData[0]];
    for (let i = 1; i < uData.length; i++) {
        const series = uData[i];
        let min = Infinity, max = -Infinity;
        for(let j=0; j<series.length; j++) {
            if(series[j] < min) min = series[j];
            if(series[j] > max) max = series[j];
        }
        const range = max - min || 1;
        const nSeries = new Float64Array(series.length);
        for(let j=0; j<series.length; j++) {
            nSeries[j] = (series[j] - min) / range;
        }
        normData.push(nSeries);
    }
}

document.getElementById('scaleBtn').onclick = function() {
    if (chart) { currentXMin = chart.scales.x.min; currentXMax = chart.scales.x.max; }
    if (currentScaleMode === 'Linear') { 
        currentScaleMode = 'log'; 
        this.innerText = 'Scale: Log'; 
    } else if (currentScaleMode === 'log') { 
        currentScaleMode = 'norm'; 
        this.innerText = 'Scale: Norm'; 
        prepareNormalizedData();
    } else { 
        currentScaleMode = 'Linear'; 
        this.innerText = 'Scale: Linear'; 
    }
    renderChart();
};

function initDatePickers(min, max) {
    const config = { enableTime: true, dateFormat: "Y-m-d H:i", time_24hr: true, minDate: min ? new Date(min * 1000) : null, maxDate: max ? new Date(max * 1000) : null };
    if (fpStart) { fpStart.destroy(); fpEnd.destroy(); }
    fpStart = flatpickr("#startDate", config);
    fpEnd = flatpickr("#endDate", config);
}

function createSidebar() {
    const cont = document.getElementById('legend-container');
    cont.innerHTML = '';
    columns.slice(1).forEach((name, i) => {
        const div = document.createElement('div');
        div.className = 'col-item';
        div.innerHTML = `<input type="checkbox" id="ch-${i}" class="col-ch"><label for="ch-${i}">${name}</label>`;
        cont.appendChild(div);
    });
    document.querySelectorAll('.col-ch').forEach((cb, i) => {
    cb.onchange = () => { 
        if (chart) {
            const checkedCount = document.querySelectorAll('.col-ch:checked').length;
            if (isDualY && checkedCount < 2) {
                isDualY = false;
                const btn = document.getElementById('dualYBtn');
                btn.innerText = "Dual Y: Off";
                btn.style.background = "#2980b9";
                renderChart(); 
            } else {
                renderChart(); 
            }
        }
    };
});
}

function toggleAllSeries(show) {
    document.querySelectorAll('.col-ch').forEach((cb, i) => {
        cb.checked = show;
        if (chart) chart.setSeries(i + 1, { show: show });
    });
}

document.getElementById('exportBtn').onclick = async () => {
    if (!uData.length || !chart) return;
    const xMin = chart.scales.x.min;
    const xMax = chart.scales.x.max;
    const activeIndices = [0];
    columns.slice(1).forEach((_, i) => {
        if (document.getElementById(`ch-${i}`).checked) activeIndices.push(i + 1);
    });
    if (activeIndices.length <= 1) {
        alert("Please select at least one data series to export.");
        return;
    }
    const savePath = await ipcRenderer.invoke('save-dialog', 'csv');
    if (!savePath) return;
    let csvContent = activeIndices.map(idx => columns[idx]).join(',') + '\n';
    for (let i = 0; i < uData[0].length; i++) {
        const timestamp = uData[0][i];
        if (timestamp >= xMin && timestamp <= xMax) {
            const row = activeIndices.map(idx => {
                if (idx === 0) return uPlot.fmtDate("{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}")(new Date(timestamp * 1000));
                return uData[idx][i];
            });
            csvContent += row.join(',') + '\n';
        }
    }
    fs.writeFileSync(savePath, csvContent, 'utf8');
    alert("CSV Exported successfully!");
};

document.getElementById('snapBtn').onclick = async () => {
    const canvas = document.querySelector('#chart-area canvas');
    if (!canvas) return;

    const savePath = await ipcRenderer.invoke('save-dialog', 'jpg');
    if (!savePath) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const ctx = tempCanvas.getContext('2d');

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    ctx.drawImage(canvas, 0, 0);

    if (chart) {
        const padding = 25;
        const lineheight = 22;
        const boxSize = 12;
        ctx.font = "bold 12px Arial";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";

        const activeSeries = chart.series.filter((s, i) => i > 0 && s.show);

        activeSeries.forEach((s, i) => {
            const yPos = padding + (i * lineheight);
            ctx.fillStyle = "#000000"; 
            ctx.fillText(s.label, tempCanvas.width - padding - (boxSize + 8), yPos);

            const seriesColor = typeof s.stroke === 'function' ? s.stroke(chart, activeSeries.indexOf(s) + 1) : s.stroke;
            ctx.beginPath(); 
            ctx.fillStyle = seriesColor; 
            ctx.fillRect(tempCanvas.width - padding - boxSize, yPos - (boxSize / 2), boxSize, boxSize);
            ctx.strokeStyle = "rgba(0,0,0,0.3)";
            ctx.lineWidth = 1;
            ctx.strokeRect(tempCanvas.width - padding - boxSize, yPos - (boxSize / 2), boxSize, boxSize);
        });
    }

    const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.9);
    const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    fs.writeFileSync(savePath, base64Data, 'base64');
    alert("Screenshot saved!");
};

document.getElementById('zoomModeBtn').onclick = () => switchMode('zoom');
document.getElementById('panModeBtn').onclick = () => switchMode('pan');
document.getElementById('diffModeBtn').onclick = () => switchMode('diff');
document.getElementById('allBtn').onclick = () => toggleAllSeries(true);
document.getElementById('noneBtn').onclick = () => toggleAllSeries(false);
document.getElementById('applyBtn').onclick = () => {
    if(!fpStart.selectedDates[0] || !fpEnd.selectedDates[0]) return;
    currentXMin = fpStart.selectedDates[0].getTime() / 1000;
    currentXMax = fpEnd.selectedDates[0].getTime() / 1000;
    renderChart();
};

document.getElementById('rangeSelect').onchange = function() {
    if (!dataMaxTime) return;
    let dur = 0; const val = this.value;
    if (val === '1h') dur = 3600; else if (val === '1d') dur = 86400; else if (val === '1w') dur = 604800; else if (val === '1m') dur = 2592000; else if (val === '1y') dur = 31536000;
    if (dur > 0) {
        currentXMax = dataMaxTime; currentXMin = Math.max(dataMinTime, dataMaxTime - dur);
        fpStart.setDate(new Date(currentXMin * 1000)); fpEnd.setDate(new Date(currentXMax * 1000));
        renderChart();
    }
};
document.getElementById('dualYBtn').onclick = function() {
    if (!uData || uData.length === 0) {
        alert("Please load a CSV file first.");
        return;
    }
    const activeIndices = [];
    document.querySelectorAll('.col-ch').forEach((cb, i) => {
        if (cb.checked) activeIndices.push(i + 1);
    });
    if (activeIndices.length < 2) {
        alert("Dual Y mode requires at least 2 selected data series.");
        return;
    }
    isDualY = !isDualY;
    this.innerText = isDualY ? "Dual Y: On" : "Dual Y: Off";
    this.style.background = isDualY ? "#8e44ad" : "#2980b9";
    if (chart) renderChart();
};
function wheelZoomPlugin() {
    return { hooks: { init: u => {
        u.over.addEventListener("wheel", e => {
            e.preventDefault();
            const xVal = u.posToVal(e.clientX - u.over.getBoundingClientRect().left, "x");
            const zoom = e.deltaY < 0 ? 0.8 : 1.2;
            u.setScale("x", { 
                min: Math.max(dataMinTime, xVal - (xVal - u.scales.x.min) * zoom),
                max: Math.min(dataMaxTime, xVal + (u.scales.x.max - xVal) * zoom)
            });
        });
    }}};
}

function panPlugin() {
    return { hooks: { init: u => {
        let startX, sMin, sMax;
        u.over.addEventListener("mousedown", e => {
            if (currentMode === 'pan' && e.button === 0) {
                startX = e.clientX; sMin = u.scales.x.min; sMax = u.scales.x.max;
                const move = ev => {
                    const dist = ((startX - ev.clientX) / u.bbox.width) * (sMax - sMin);
                    let nMin = sMin + dist, nMax = sMax + dist;
                    if (nMin < dataMinTime) { nMin = dataMinTime; nMax = nMin + (sMax - sMin); }
                    if (nMax > dataMaxTime) { nMax = dataMaxTime; nMin = nMax - (sMax - sMin); }
                    u.setScale("x", { min: nMin, max: nMax });
                };
                const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
                document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
            }
        });
    }}};
}

function contextMenuPlugin() {
    return { hooks: { init: u => {
        u.over.oncontextmenu = e => {
            e.preventDefault();
            const menu = document.createElement('div');
            menu.style = `position:fixed; left:${e.clientX}px; top:${e.clientY}px; background:white; border:1px solid #ccc; padding:8px; cursor:pointer; z-index:9999; font-size:12px; color:black;`;
            menu.innerText = 'View All';
            menu.onclick = () => {
                currentXMin = dataMinTime; currentXMax = dataMaxTime;
                fpStart.setDate(new Date(dataMinTime * 1000)); fpEnd.setDate(new Date(dataMaxTime * 1000));
                u.setScale("x", { min: dataMinTime, max: dataMaxTime });
                menu.remove();
            };
            document.body.appendChild(menu);
            const close = () => { if(menu.parentNode) menu.remove(); document.removeEventListener('click', close); };
            setTimeout(() => document.addEventListener('click', close), 10);
        };
    }}};
}
