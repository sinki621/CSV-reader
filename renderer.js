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

function symlog(v) { return Math.asinh(v / LIN_THRESH); }
function invSymlog(v) { return Math.sinh(v) * LIN_THRESH; }

function switchMode(mode) {
    if (chart) { currentXMin = chart.scales.x.min; currentXMax = chart.scales.x.max; }
    currentMode = mode;
    const btns = { 'zoom': 'zoomModeBtn', 'pan': 'panModeBtn', 'diff': 'diffModeBtn' };
    Object.keys(btns).forEach(k => {
        const b = document.getElementById(btns[k]);
        if (b) b.style.background = (k === mode) ? '#e67e22' : '#2980b9';
    });
    if (mode === 'diff') { diffPoints = []; document.getElementById('pinned-data').innerHTML = "<b>Diff Mode:</b> Click 두 점."; }
    if (chart) renderChart();
}

window.onload = () => {
    switchMode('zoom');
    window.addEventListener("resize", () => {
        if (chart) chart.setSize({ width: document.getElementById('chart-area').offsetWidth, height: document.getElementById('chart-area').offsetHeight });
    });
};

document.getElementById('loadBtn').onclick = async () => {
    const filePath = await ipcRenderer.invoke('open-file');
    if (!filePath) return;
    const status = document.getElementById('status');
    status.innerText = "Loading...";
    if (chart) { chart.destroy(); chart = null; }
    uData = []; normData = [];
    setTimeout(() => loadHugeFile(filePath, status), 50);
};

async function loadHugeFile(filePath, status) {
    const stats = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    let rowCount = 0, leftover = '';
    let lastValues; 

    stream.on('data', (chunk) => {
        const lines = (leftover + chunk).split(/\r?\n/);
        leftover = lines.pop();
        for (let line of lines) {
            const cells = line.trim().split(',');
            if (!cells[0]) continue;
            if (rowCount === 0) {
                columns = cells.map(c => c.trim());
                uData = columns.map(() => []);
                lastValues = new Float64Array(columns.length).fill(0);
                rowCount++; continue;
            }
            const timeVal = Date.parse(cells[0]) / 1000;
            if (isNaN(timeVal)) continue;
            uData[0].push(timeVal);
            for (let j = 1; j < columns.length; j++) {
                const val = parseFloat(cells[j]);
                const finalVal = isNaN(val) ? lastValues[j] : val;
                uData[j].push(finalVal);
                lastValues[j] = finalVal;
            }
            rowCount++;
        }
        status.innerText = `Loading.. (${Math.round((stream.bytesRead / stats.size) * 100)}%)`;
    });

    stream.on('end', () => {
        uData = uData.map(arr => new Float64Array(arr));
        dataMinTime = uData[0][0]; dataMaxTime = uData[0][uData[0].length - 1];
        initDatePickers(dataMinTime, dataMaxTime);
        createSidebar(); renderChart();
        status.innerText = `Loaded: ${uData[0].length.toLocaleString()} rows`;
    });
}

function renderChart() {
    const container = document.getElementById('chart-area');
    const overlay = document.getElementById('overlay-legend');
    if (!container || !uData[0]) return;
    if (chart) chart.destroy();
    container.innerHTML = '';

    const isSymlog = currentScaleMode === 'log';
    const isNorm = currentScaleMode === 'norm';
    let activeData = isNorm ? (normData.length ? normData : prepareNormalizedData()) : (isSymlog ? uData.map((s, i) => i === 0 ? s : s.map(v => symlog(v))) : uData);

    const opts = {
        width: container.offsetWidth - 20, height: container.offsetHeight - 20,
        legend: { show: false },
        cursor: { 
            drag: { setScale: currentMode === 'zoom', x: currentMode === 'zoom', y: false },
            focus: { prox: 50 }
        },
        hooks: {
            setCursor: [u => {
                if (u.cursor.left < 0) { overlay.style.display = "none"; return; }
                let html = "";
                u.series.forEach((s, i) => {
                    if (i > 0 && s.show) {
                        html += `<div class="ol-item"><div class="ol-dot" style="background:${s.stroke}"></div>${s.label}</div>`;
                    }
                });
                overlay.innerHTML = html;
                overlay.style.display = html ? "block" : "none";
            }],
            init: [u => {
                u.over.addEventListener("mousedown", e => {
                    if (e.button !== 0 || u.cursor.idx == null) return;
                    const idx = u.cursor.idx;
                    let html = `<span style="background:#34495e;color:#fff;padding:2px 8px;border-radius:4px;margin-right:10px;">${uPlot.fmtDate("{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}")(new Date(uData[0][idx]*1000))}</span>`;
                    columns.slice(1).forEach((name, i) => {
                        if (u.series[i+1].show) html += `<span style="margin-right:15px;border-bottom:2px solid ${u.series[i+1].stroke};"><b>${name}:</b> ${uData[i+1][idx].toExponential(2)}</span>`;
                    });
                    document.getElementById('pinned-data').innerHTML = html;
                    if (currentMode === 'diff') {
                        diffPoints.push({ time: uData[0][idx], vals: columns.slice(1).map((_, i) => uData[i+1][idx]) });
                        if (diffPoints.length > 2) diffPoints.shift();
                        updateDiffDisplay();
                    }
                });
            }]
        },
        scales: { x: { time: true, min: currentXMin || dataMinTime, max: currentXMax || dataMaxTime }, y: { auto: true }, y2: { auto: true } },
        series: [{ label: "Time" }, ...columns.slice(1).map((name, i) => {
            const isChecked = document.getElementById(`ch-${i}`)?.checked ?? false;
            return { label: name, show: isChecked, stroke: `hsl(${(i * 137.5) % 360}, 70%, 50%)`, width: 1.5, scale: isDualY && isChecked ? 'y2' : 'y' };
        })],
        axes: [
            { space: 60, values: [[3600*24, "{MM}-{DD}"], [1, "{HH}:{mm}:{ss}"]] },
            { scale: 'y', stroke: isDualY ? "#2980b9" : "#333", values: (u, v) => v.map(n => isNorm ? n.toFixed(2) : (isSymlog ? invSymlog(n) : n).toExponential(2)) },
            { show: isDualY, scale: 'y2', side: 1, stroke: "#e67e22", values: (u, v) => v.map(n => (isSymlog ? invSymlog(n) : n).toExponential(2)) }
        ],
        plugins: [wheelZoomPlugin(), panPlugin(), contextMenuPlugin()]
    };
    chart = new uPlot(opts, activeData, container);
}

function updateDiffDisplay() {
    const cont = document.getElementById('pinned-data');
    if (diffPoints.length < 1) return;
    let html = `<div style="display:flex; gap:15px;">`;
    diffPoints.forEach((p, i) => {
        html += `<div style="border:1px solid #ccc;padding:5px;"><b>P${i+1}</b> (${uPlot.fmtDate("{HH}:{mm}:{ss}")(new Date(p.time*1000))})</div>`;
    });
    if (diffPoints.length === 2) {
        html += `<div style="background:#eee;padding:5px;flex-grow:1;"><b>Diff:</b> `;
        columns.slice(1).forEach((name, i) => { if (chart.series[i+1].show) html += `${name}: ${(diffPoints[1].vals[i] - diffPoints[0].vals[i]).toExponential(2)} | `; });
        html += `</div>`;
    }
    cont.innerHTML = html + `</div>`;
}

function prepareNormalizedData() {
    normData = [uData[0]];
    for (let i = 1; i < uData.length; i++) {
        const s = uData[i], min = Math.min(...s), max = Math.max(...s), r = max - min || 1;
        normData.push(s.map(v => (v - min) / r));
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
    fpStart = flatpickr("#startDate", cfg); fpEnd = flatpickr("#endDate", cfg);
    fpStart.setDate(new Date(min*1000)); fpEnd.setDate(new Date(max*1000));
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
