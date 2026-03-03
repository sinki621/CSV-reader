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

// --- Asinh(Inverse Hyperbolic Sine) 설정 ---
// 사용자의 데이터가 1e-6보다 작으므로 기준값을 1e-12로 설정하여 
// 미세한 값들의 변화를 로그 스케일로 확장해서 볼 수 있게 합니다.
const LIN_THRESH = 1e-12; 

function symlog(v) {
    // Asinh 변환: 원점 부근은 선형, 값이 커지면 로그로 동작
    return Math.asinh(v / LIN_THRESH);
}

function invSymlog(v) {
    // Asinh 역변환: 화면의 좌표값을 실제 데이터 값으로 복원
    return Math.sinh(v) * LIN_THRESH;
}

function switchMode(mode) {
    if (chart) { 
        currentXMin = chart.scales.x.min; 
        currentXMax = chart.scales.x.max; 
    }
    currentMode = mode;

    // 모드 버튼들 ID 배열
    const modeButtons = {
        'zoom': 'zoomModeBtn',
        'pan': 'panModeBtn',
        'diff': 'diffModeBtn'
    };

    // 모든 버튼의 색상을 기본 파란색(#2980b9)으로 초기화하고, 
    // 선택된 모드만 강조색(주황색 계열 #e67e22)으로 변경
    Object.keys(modeButtons).forEach(key => {
        const btn = document.getElementById(modeButtons[key]);
        if (btn) {
            if (key === mode) {
                // 선택된 버튼: 강조색 (주황색)
                btn.style.background = '#e67e22'; 
            } else {
                // 선택되지 않은 버튼: 일반 파란색
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
    // 창 크기 변경 시 차트 리사이즈 대응
    window.addEventListener("resize", () => {
        if (chart) {
            chart.setSize({
                width: document.getElementById('chart-area').offsetWidth,
                height: document.getElementById('chart-area').offsetHeight
            });
        }
    });
};
// --- 파일 로딩 로직 ---
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

// --- 차트 렌더링 ---
function renderChart() {
    const container = document.getElementById('chart-area');
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
        // Asinh 변환 적용
        activeData = uData.map((series, i) => i === 0 ? series : series.map(v => symlog(v)));
    }
    const activeSeriesIndices = [];
    columns.slice(1).forEach((_, i) => {
        if (document.getElementById(`ch-${i}`)?.checked) activeSeriesIndices.push(i + 1);
    });

    const opts = {
        width: container.offsetWidth - 20,
        height: container.offsetHeight - 20,
        legend: { show: false },
        padding: [10, 20, 0, 10],
        cursor: { 
            drag: { setScale: currentMode === 'zoom', x: currentMode === 'zoom', y: false },
            points: { size: 12, fill: (u, si) => u.series[si].stroke + "66", stroke: (u, si) => u.series[si].stroke, width: 2 },
            
            // --- 촘촘한 데이터에서 Spike 포착 강화 ---
            focus: { prox: 50 }, 
            // 거리 계산 방식 커스터마이징
            dist: (u, seriesIdx, dataIdx, x, y) => {
                let s = u.series[seriesIdx];
                let d = u.data[seriesIdx];
                
                // 캔버스 상의 실제 좌표값을 계산
                let dx = u.valToPos(u.data[0][dataIdx], 'x') - x;
                let dy = u.valToPos(d[dataIdx], 'y') - y;
                
                // 피타고라스 정리를 사용하여 마우스 커서와 데이터 포인트 간의 실제 물리적 거리 계산
                // 이 수식을 통해 X축뿐만 아니라 Y축으로 멀리 떨어진 Spike도 감지하게 됩니다.
                return Math.sqrt(dx * dx + dy * dy);
            }
        },
        hooks: {
            setCursor: [u => {
                const { left, top, idx } = u.cursor;
                if (idx == null || left < 0) { tooltip.style.display = "none"; return; }
                const timeStr = uPlot.fmtDate("{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}")(new Date(uData[0][idx] * 1000));
                let content = `<div style="font-weight:bold; border-bottom:1px solid #ccc; padding-bottom:4px; margin-bottom:6px;">${timeStr}</div>`;
                columns.slice(1).forEach((name, i) => {
                    if (u.series[i + 1].show) {
                        const val = uData[i+1][idx];
                        const formattedVal = val === 0 ? "0e0" : val.toExponential().replace('+', '');
                        content += `<div style="color:${u.series[i + 1].stroke}; font-weight:500;">● ${name}: ${formattedVal}</div>`;
                    }
                });
                tooltip.style.display = "block";
                tooltip.innerHTML = content;
                const bBox = container.getBoundingClientRect();
                let xPos = left + bBox.left + 25;
                if (xPos + 200 > window.innerWidth) xPos = left + bBox.left - 210;
                tooltip.style.left = xPos + "px";
                tooltip.style.top = (top + bBox.top + 25) + "px";
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
                                // 자릿수 제한 없이 원본 값을 지수 표기법으로 변환
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
                        // --- Diff 모드 로직 ---
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
                const seriesIdx = i + 1;
                const isChecked = document.getElementById(`ch-${i}`)?.checked || false;
                
                // Dual Y 모드일 때 첫 번째 활성 데이터만 'y', 나머지는 'y2' 할당
                let scaleKey = 'y';
                if (isDualY && isChecked) {
                // 현재 시리즈가 체크된 것들 중 몇 번째인지 확인
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
                    scale: scaleKey // 축 결정 로직 반영
                };
            })
        ],
        axes: [
            { 
                space: 60, 
                values: [[3600*24*365, "{YYYY}"], [3600*24, "{MM}-{DD}"], [3600, "{HH}:{mm}"], [1, "{HH}:{mm}:{ss}"]] 
            },
            { 
                scale: 'y', // 왼쪽 축
                size: 90, 
                stroke: isDualY ? "#2980b9" : "#333", // Dual 모드일 때 색상 강조
                values: (u, vals) => vals.map(v => {
                    const realVal = isSymlog ? invSymlog(v) : v;
                    return isNorm ? v.toFixed(2) : realVal.toExponential(2).replace('+', '');
                })
            },
            {
                show: isDualY, // Dual 모드일 때만 표시
                scale: 'y2', // 오른쪽 축
                side: 1, // 오른쪽 배치
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

// --- UI 제어 ---

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
            // Dual Y 모드일 때 체크된 개수가 2개 미만으로 떨어지면 강제로 일반 모드로 전환하거나 재렌더링
            const checkedCount = document.querySelectorAll('.col-ch:checked').length;
            if (isDualY && checkedCount < 2) {
                // 선택지가 두 가지입니다:
                // 1. 자동으로 Dual Y를 끄기
                isDualY = false;
                const btn = document.getElementById('dualYBtn');
                btn.innerText = "Dual Y: Off";
                btn.style.background = "#2980b9";
                renderChart(); 
            } else {
                // 일반적인 경우 차트 갱신
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

// --- Export CSV & Screenshot ---
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

    // 배경 흰색
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    
    // 차트 복사
    ctx.drawImage(canvas, 0, 0);

    if (chart) {
        const padding = 25;
        const lineheight = 22;
        const boxSize = 12;
        ctx.font = "bold 12px Arial";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";

        // 데이터 시리즈만 추출 (시간축 제외 및 현재 표시 중인 것만)
        const activeSeries = chart.series.filter((s, i) => i > 0 && s.show);

        activeSeries.forEach((s, i) => {
            const yPos = padding + (i * lineheight);
            
            // 1. 텍스트 그리기 (검은색)
            ctx.fillStyle = "#000000"; 
            ctx.fillText(s.label, tempCanvas.width - padding - (boxSize + 8), yPos);

            // 2. 색상 박스 그리기 (차트 선 색상 적용)
            // s.stroke가 함수일 경우를 대비해 실행하거나 값을 가져옵니다.
            const seriesColor = typeof s.stroke === 'function' ? s.stroke(chart, activeSeries.indexOf(s) + 1) : s.stroke;
            
            ctx.beginPath(); // 경로 초기화로 색상 간섭 방지
            ctx.fillStyle = seriesColor; 
            ctx.fillRect(tempCanvas.width - padding - boxSize, yPos - (boxSize / 2), boxSize, boxSize);
            
            // 3. 박스 테두리 (회색)
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

// --- 기존 핸들러 ---
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
    // 1. 데이터가 로드되었는지 확인
    if (!uData || uData.length === 0) {
        alert("Please load a CSV file first.");
        return;
    }

    // 2. 현재 체크된 데이터 시리즈 개수 확인
    const activeIndices = [];
    document.querySelectorAll('.col-ch').forEach((cb, i) => {
        if (cb.checked) activeIndices.push(i + 1);
    });

    // 3. 2개 미만일 경우 알람 띄우고 종료
    if (activeIndices.length < 2) {
        alert("Dual Y mode requires at least 2 selected data series.");
        return;
    }

    // 4. 정상 작동 시 상태 변경
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
