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
    const modeButtons = { 'zoom': 'zoomModeBtn', 'pan': 'panModeBtn', 'diff': 'diffModeBtn' };
    Object.keys(modeButtons).forEach(key => {
        const btn = document.getElementById(modeButtons[key]);
        if (btn) btn.style.background = (key === mode) ? '#e67e22' : '#2980b9';
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
                if (rawVal === "") { uData[j].push(lastValues[j]); }
                else {
                    const parsed = parseFloat(rawVal);
                    if (isNaN(parsed)) { uData[j].push(lastValues[j]); }
                    else { uData[j].push(parsed); lastValues[j] = parsed; }
                }
            }
            rowCount++;
        }
        status.innerText = `Loading.. (${Math.round((stream.bytesRead / stats.size) * 100)}%)`;
    });

    stream.on('end', () => {
        for (let i = 0; i < uData.length; i++) { uData[i] = new Float64Array(uData[i]); }
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
    const overlayLegend = document.getElementById('overlay-legend');
    if (!container || !uData[0] || uData[0].length === 0) return;
    if (chart) chart.destroy();
    container.innerHTML = '';

    const isSymlog = currentScaleMode === 'log';
    const isNorm = currentScaleMode === 'norm';
    let activeData = isNorm ? (normData.length ? normData : prepareNormalizedData()) : (isSymlog ? uData.map((s, i) => i === 0 ? s : s.map(v => symlog(v))) : uData);

    const opts = {
        width: container.offsetWidth - 20,
        height: container.offsetHeight - 20,
        legend: { show: false },
        cursor: { 
            drag: { setScale: currentMode === 'zoom', x: currentMode === 'zoom', y: false },
            points: { size: 10, fill: (u, si) => u.series[si].stroke + "44", stroke: (u, si) => u.series[si].stroke },
            focus: { prox: 50 }
        },
        hooks: {
            setCursor: [u => {
                const { left, top, idx } = u.cursor;
                if (idx == null || left < 0) { 
                    overlayLegend.style.display = "none"; 
                    tooltip.style.display = "none";
                    return; 
                }

                const timeStr = uPlot.fmtDate("{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}")(new Date(uData[0][idx] * 1000));
                let legendHtml = `<div class="ol-time">${timeStr}</div>`;
                let hasActive = false;

                // 실시간 범례 구성
                columns.slice(1).forEach((name, i) => {
                    const seriesIdx = i + 1;
                    if (u.series[seriesIdx].show) {
                        hasActive = true;
                        const val = uData[seriesIdx][idx];
                        const formattedVal = val === 0 ? "0e0" : val.toExponential(4).replace('+', '');
                        const color = u.series[seriesIdx].stroke;
                        
                        legendHtml += `
                            <div class="ol-item">
                                <div class="ol-dot" style="background:${color}"></div>
                                <span class="ol-label">${name}</span>
                                <span class="ol-value">${formattedVal}</span>
                            </div>`;
                    }
                });

                if (hasActive) {
                    overlayLegend.innerHTML = legendHtml;
                    overlayLegend.style.display = "block";
                } else {
                    overlayLegend.style.display = "none";
                }
            }],
            init: [u => {
                u.over.addEventListener("mousedown", e => {
                    if (e.button !== 0) return; 
                    const idx = u.cursor.idx;
                    if (idx != null) {
                        let html = `<span style="background: #34495e; color: white; padding: 2px 10px; border-radius: 4px; margin-right: 15px; font-weight: bold;">
                                        ${uPlot.fmtDate("{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}")(new Date(uData[0][idx] * 1000))}
                                    </span>`;
                        columns.slice(1).forEach((name, i) => {
                            if (u.series[i + 1].show) {
                                const val = uData[i+1][idx];
                                const rawExpVal = val === 0 ? "0e0" : val.toExponential().replace('+', '');
                                html += `<span style="display: inline-block; margin-right: 18px; border-bottom: 2px solid ${u.series[i+1].stroke};">
                                            <b style="color: #444;">${name}:</b> 
                                            <span style="color: ${u.series[i+1].stroke}; font-family: monospace; font-weight: bold; margin-left: 4px;">${rawExpVal}</span>
                                         </span>`;
                            }
                        });
                        document.getElementById('pinned-data').innerHTML = html;
                    }
                    if (currentMode === 'diff' && idx != null) {
                        diffPoints.push({ time: uData[0][idx], vals: columns.slice(1).map((_, i) => uData[i+1][idx]) });
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
                return {
                    label: name,
                    show: isChecked,
                    stroke: `hsl(${(i * 137.5) % 360}, 70%, 50%)`,
                    width: 1.5,
                    scale: isDualY && isChecked ? (Array.from(document.querySelectorAll('.col-ch')).slice(0, i).filter(c => c.checked).length === 0 ? 'y' : 'y2') : 'y'
                };
            })
        ],
        axes: [
            { space: 60, values: [[3600*24*365, "{YYYY}"], [3600*24, "{MM}-{DD}"], [3600, "{HH}:{mm}"], [1, "{HH}:{mm}:{ss}"]] },
            { scale: 'y', size: 90, stroke: isDualY ? "#2980b9" : "#333", values: (u, vals) => vals.map(v => isNorm ? v.toFixed(2) : (isSymlog ? invSymlog(v) : v).toExponential(2).replace('+', '')) },
            { show: isDualY, scale: 'y2', side: 1, grid: { show: false }, size: 90, stroke: "#e67e22", values: (u, vals) => vals.map(v => isNorm ? v.toFixed(2) : (isSymlog ? invSymlog(v) : v).toExponential(2).replace('+', '')) }
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
        html += `<div style="border:1px solid #ccc; padding:8px; border-radius:4px; font-size:12px;"><b style="color:#2980b9;">P${i+1} (${uPlot.fmtDate("{HH}:{mm}:{ss}")(new Date(p.time * 1000))})</b><br>`;
        p.vals.forEach((v, si) => { if (chart.series[si+1].show) html += `<div style="font-family:monospace;">${v.toExponential(2)}</div>`; });
        html += `</div>`;
    });
    if (diffPoints.length === 2) {
        html += `<div style="flex-grow:1; background:#ecf0f1; padding:8px; border-radius:4px; border-left:4px solid #e67e22;"><b style="color:#e67e22;">Difference (P2 - P1)</b><br>`;
        columns.slice(1).forEach((name, i) => {
            if (chart.series[i+1].show) {
                const delta = diffPoints[1].vals[i] - diffPoints[0].vals[i];
                const pct = diffPoints[0].vals[i] !== 0 ? ((delta / Math.abs(diffPoints[0].vals[i])) * 100).toFixed(2) : "∞";
                html += `<div style="font-size:11px;"><b>${name}:</b> ${delta.toExponential()} <span style="color:${delta >= 0 ? 'red' : 'blue'};">(${delta >= 0 ? '+' : ''}${pct}%)</span></div>`;
            }
        });
        html += `</div>`;
    }
    cont.innerHTML = html + `</div>`;
}

function prepareNormalizedData() {
    normData = [uData[0]];
    for (let i = 1; i < uData.length; i++) {
        const series = uData[i];
        let min = Math.min(...series), max = Math.max(...series);
        const range = max - min || 1;
        normData.push(series.map(v => (v - min) / range));
    }
    return normData;
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
    document.querySelectorAll('.col-ch').forEach(cb => cb.onchange = () => renderChart());
}

function initDatePickers(min, max) {
    const cfg = { enableTime: true, dateFormat: "Y-m-d H:i", time_24hr: true, minDate: new Date(min * 1000), maxDate: new Date(max * 1000) };
    fpStart = flatpickr("#startDate", cfg);
    fpEnd = flatpickr("#endDate", cfg);
}

document.getElementById('scaleBtn').onclick = function() {
    currentScaleMode = currentScaleMode === 'Linear' ? 'log' : (currentScaleMode === 'log' ? 'norm' : 'Linear');
    this.innerText = `Scale: ${currentScaleMode}`;
    if (chart) { currentXMin = chart.scales.x.min; currentXMax = chart.scales.x.max; renderChart(); }
};

document.getElementById('allBtn').onclick = () => { document.querySelectorAll('.col-ch').forEach(c => c.checked = true); renderChart(); };
document.getElementById('noneBtn').onclick = () => { document.querySelectorAll('.col-ch').forEach(c => c.checked = false); renderChart(); };
document.getElementById('applyBtn').onclick = () => { if(fpStart.selectedDates[0]) { currentXMin = fpStart.selectedDates[0].getTime()/1000; currentXMax = fpEnd.selectedDates[0].getTime()/1000; renderChart(); } };

document.getElementById('rangeSelect').onchange = function() {
    const dur = { '1h': 3600, '1d': 86400, '1w': 604800, '1m': 2592000, '1y': 31536000 }[this.value];
    if (dur) { currentXMax = dataMaxTime; currentXMin = Math.max(dataMinTime, dataMaxTime - dur); renderChart(); }
};

document.getElementById('exportBtn').onclick = async () => {
    const savePath = await ipcRenderer.invoke('save-dialog', 'csv');
    if (!savePath || !chart) return;
    const active = [0]; columns.slice(1).forEach((_, i) => { if(document.getElementById(`ch-${i}`).checked) active.push(i+1); });
    let csv = active.map(idx => columns[idx]).join(',') + '\n';
    for (let i=0; i<uData[0].length; i++) {
        if (uData[0][i] >= chart.scales.x.min && uData[0][i] <= chart.scales.x.max)
            csv += active.map(idx => idx === 0 ? uPlot.fmtDate("{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}")(new Date(uData[0][i]*1000)) : uData[idx][i]).join(',') + '\n';
    }
    fs.writeFileSync(savePath, csv);
};

document.getElementById('snapBtn').onclick = async () => {
    const canvas = document.querySelector('#chart-area canvas');
    const savePath = await ipcRenderer.invoke('save-dialog', 'jpg');
    if (!canvas || !savePath) return;
    const temp = document.createElement('canvas');
    temp.width = canvas.width; temp.height = canvas.height;
    const ctx = temp.getContext('2d');
    ctx.fillStyle = "#fff"; ctx.fillRect(0,0,temp.width,temp.height);
    ctx.drawImage(canvas, 0, 0);
    fs.writeFileSync(savePath, temp.toDataURL('image/jpeg', 0.9).split(',')[1], 'base64');
};

document.getElementById('dualYBtn').onclick = function() {
    isDualY = !isDualY;
    this.innerText = `Dual Y: ${isDualY ? 'On' : 'Off'}`;
    this.style.background = isDualY ? "#8e44ad" : "#2980b9";
    renderChart();
};

function wheelZoomPlugin() {
    return { hooks: { init: u => u.over.addEventListener("wheel", e => {
        e.preventDefault();
        const xVal = u.posToVal(e.clientX - u.over.getBoundingClientRect().left, "x");
        const zoom = e.deltaY < 0 ? 0.8 : 1.2;
        u.setScale("x", { min: Math.max(dataMinTime, xVal - (xVal - u.scales.x.min) * zoom), max: Math.min(dataMaxTime, xVal + (u.scales.x.max - xVal) * zoom) });
    })}};
}

function panPlugin() {
    return { hooks: { init: u => {
        let startX, sMin, sMax;
        u.over.addEventListener("mousedown", e => {
            if (currentMode === 'pan' && e.button === 0) {
                startX = e.clientX; sMin = u.scales.x.min; sMax = u.scales.x.max;
                const move = ev => {
                    const dist = ((startX - ev.clientX) / u.bbox.width) * (sMax - sMin);
                    u.setScale("x", { min: Math.max(dataMinTime, sMin + dist), max: Math.min(dataMaxTime, sMax + dist) });
                };
                const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
                document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
            }
        });
    }}};
}

function contextMenuPlugin() {
    return { hooks: { init: u => u.over.oncontextmenu = e => {
        e.preventDefault();
        const m = document.createElement('div');
        m.style = `position:fixed; left:${e.clientX}px; top:${e.clientY}px; background:white; border:1px solid #ccc; padding:8px; cursor:pointer; z-index:9999; font-size:12px;`;
        m.innerText = 'View All';
        m.onclick = () => { u.setScale("x", { min: dataMinTime, max: dataMaxTime }); m.remove(); };
        document.body.appendChild(m);
        setTimeout(() => document.addEventListener('click', () => m.remove(), {once:true}), 10);
    }}};
}
