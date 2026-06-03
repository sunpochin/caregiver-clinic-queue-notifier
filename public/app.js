// 前端主應用程式邏輯
document.addEventListener('DOMContentLoaded', () => {
    // 獲取 DOM 元素
    const deptSelect = document.getElementById('deptSelect');
    const noonSelect = document.getElementById('noonSelect');
    const clinicSelect = document.getElementById('clinicSelect');
    const customClinicGroup = document.getElementById('customClinicGroup');
    const clinicInput = document.getElementById('clinicInput');
    const doctorInput = document.getElementById('doctorInput');
    const targetNumberInput = document.getElementById('targetNumberInput');
    const thresholdInput = document.getElementById('thresholdInput');
    const mockModeCheckbox = document.getElementById('mockModeCheckbox');
    
    const monitorForm = document.getElementById('monitorForm');
    const btnSubmit = document.getElementById('btnSubmit');
    const btnTestNotify = document.getElementById('btnTestNotify');
    
    const statusIndicator = document.getElementById('statusIndicator');
    const statusDot = statusIndicator.querySelector('.status-dot');
    const statusText = document.getElementById('statusText');
    const monitorCountBadge = document.getElementById('monitorCountBadge');
    const monitorsGrid = document.getElementById('monitorsGrid');
    const emptyState = document.getElementById('emptyState');
    const alertAudio = document.getElementById('alertAudio');

    // 連線重試次數與 SSE 物件
    let sseSource = null;
    let reconnectTimeout = null;

    // 1. 初始化網頁通知權限 (Web Notifications API)
    function initNotifications() {
        if ('Notification' in window) {
            if (Notification.permission === 'default') {
                Notification.requestPermission().then(permission => {
                    console.log('系統通知權限:', permission);
                });
            }
        }
    }
    initNotifications();

    // 2. 播放警報音效 (使用 Web Audio API 合成醫院風格雙音調提示音，免去外部音訊檔加載失敗的風險)
    function playAlertSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) {
                // 若不支援 Web Audio，則降級使用預設 HTML5 Audio 標籤播放
                if (alertAudio) {
                    alertAudio.currentTime = 0;
                    alertAudio.play().catch(err => console.log('音效播放受限:', err.message));
                }
                return;
            }
            
            const ctx = new AudioContext();
            
            // 第一音調：C5 (523.25 Hz)
            const osc1 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            osc1.type = 'sine';
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.frequency.setValueAtTime(523.25, ctx.currentTime);
            gain1.gain.setValueAtTime(0, ctx.currentTime);
            gain1.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
            gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
            osc1.start(ctx.currentTime);
            osc1.stop(ctx.currentTime + 0.5);
            
            // 第二音調：E5 (659.25 Hz)，延遲 0.15 秒啟動
            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.type = 'sine';
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.frequency.setValueAtTime(659.25, ctx.currentTime + 0.15);
            gain2.gain.setValueAtTime(0, ctx.currentTime + 0.15);
            gain2.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.2);
            gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.65);
            osc2.start(ctx.currentTime + 0.15);
            osc2.stop(ctx.currentTime + 0.7);
            
        } catch (err) {
            console.warn('Web Audio 播放錯誤，嘗試降級播放標籤音效:', err);
            if (alertAudio) {
                alertAudio.currentTime = 0;
                alertAudio.play().catch(e => console.log('音效降級播放亦失敗:', e.message));
            }
        }
    }

    // 3. 彈出系統推播通知
    function showBrowserNotification(title, body) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, {
                body: body,
                icon: 'https://cdn-icons-png.flaticon.com/512/822/822143.png'
            });
        }
    }

    // 4. 自後端載入科別對照表
    async function loadDepartments() {
        try {
            const res = await fetch('/api/depts');
            const depts = await res.json();
            
            // 清空選擇框並填入最新科別
            deptSelect.innerHTML = '<option value="" disabled selected>請選擇看診科別...</option>';
            Object.entries(depts).forEach(([code, name]) => {
                const opt = document.createElement('option');
                opt.value = code;
                opt.textContent = `${name} (${code})`;
                deptSelect.appendChild(opt);
            });
        } catch (err) {
            console.error('載入科別失敗:', err);
            deptSelect.innerHTML = '<option value="" disabled>載入失敗，請重新整理</option>';
        }
    }
    loadDepartments();

    // 4.5 根據所選科別與時段動態獲取診間列表 (防呆選單)
    async function loadClinics() {
        const deptCode = deptSelect.value;
        const noon = noonSelect.value;

        if (!deptCode || !noon) return;

        clinicSelect.disabled = true;
        clinicSelect.innerHTML = '<option value="" disabled selected>正在抓取高醫最新診間列表...</option>';
        customClinicGroup.style.display = 'none';
        clinicInput.required = false;
        clinicInput.value = '';
        doctorInput.value = '';

        try {
            const res = await fetch(`/api/clinics?deptCode=${deptCode}&noon=${noon}`);
            if (!res.ok) throw new Error('API 回應異常');
            
            const clinics = await res.json();

            clinicSelect.innerHTML = '<option value="" disabled>請選擇看診診間...</option>';
            
            if (clinics.length === 0) {
                const opt = document.createElement('option');
                opt.value = '__custom__';
                opt.textContent = '⚠️ 本時段無診間開放 (改手動輸入)';
                clinicSelect.appendChild(opt);
                
                // 自動切換為手動輸入
                clinicSelect.value = '__custom__';
                customClinicGroup.style.display = 'block';
                clinicInput.required = true;
            } else {
                clinics.forEach(clinic => {
                    const opt = document.createElement('option');
                    opt.value = clinic.clinicName;
                    opt.dataset.doctor = clinic.doctorName;
                    opt.textContent = `${clinic.clinicName} (${clinic.doctorName} 醫師 / 目前叫號：${clinic.currentSeq} 號)`;
                    clinicSelect.appendChild(opt);
                });

                // 新增手動輸入備用選項
                const optCustom = document.createElement('option');
                optCustom.value = '__custom__';
                optCustom.textContent = '➕ 手動輸入其他診間...';
                clinicSelect.appendChild(optCustom);
            }
            // 預設不選取任何值，強迫使用者做選擇
            clinicSelect.selectedIndex = 0;
            clinicSelect.disabled = false;
        } catch (err) {
            console.warn('動態獲取診間列表失敗，切換為手動輸入模式:', err);
            clinicSelect.innerHTML = '<option value="__custom__" selected>⚠️ 無法取得列表 (手動輸入)</option>';
            clinicSelect.disabled = false;
            customClinicGroup.style.display = 'block';
            clinicInput.required = true;
        }
    }

    // 監聽科別與時段異動
    deptSelect.addEventListener('change', loadClinics);
    noonSelect.addEventListener('change', loadClinics);

    // 監聽診間下拉選單選擇事件
    clinicSelect.addEventListener('change', () => {
        if (clinicSelect.value === '__custom__') {
            customClinicGroup.style.display = 'block';
            clinicInput.required = true;
            clinicInput.focus();
            doctorInput.value = '';
        } else {
            customClinicGroup.style.display = 'none';
            clinicInput.required = false;
            clinicInput.value = clinicSelect.value;
            
            // 自動帶入醫生姓名
            const selectedOpt = clinicSelect.options[clinicSelect.selectedIndex];
            doctorInput.value = selectedOpt.dataset.doctor || '';
        }
    });

    // 5. 建立 SSE 實時連線
    function connectSSE() {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);

        // 更新 UI 狀態為連線中
        statusDot.className = 'status-dot disconnected';
        statusText.textContent = '正在連線...';

        sseSource = new EventSource('/api/events');

        // 連線成功建立
        sseSource.onopen = () => {
            statusDot.className = 'status-dot connected';
            statusText.textContent = '監控同步中';
            console.log('與後端即時推播通道 (SSE) 連線成功！');
        };

        // 監聽一般狀態更新
        sseSource.onmessage = (event) => {
            try {
                const monitors = JSON.parse(event.data);
                renderMonitors(monitors);
            } catch (err) {
                console.error('解析監控清單資料失敗:', err);
            }
        };

        // 監聽特定警報事件 (播放音效與彈出通知)
        sseSource.addEventListener('alert', (event) => {
            try {
                const alertData = JSON.parse(event.data);
                console.log('接收到警報事件:', alertData);
                
                // 播放音效與顯示通知
                playAlertSound();
                showBrowserNotification(alertData.title, alertData.description);
            } catch (err) {
                console.error('解析警報事件資料失敗:', err);
            }
        });

        // 連線中斷時的自動重連機制
        sseSource.onerror = (err) => {
            console.warn('SSE 連線中斷，將於 5 秒後嘗試重新連線...', err);
            sseSource.close();
            statusDot.className = 'status-dot disconnected';
            statusText.textContent = '連線中斷';
            
            reconnectTimeout = setTimeout(connectSSE, 5000);
        };
    }
    connectSSE();

    // 6. 渲染監控看板卡片清單
    function renderMonitors(monitors) {
        // 更新數量徽章
        monitorCountBadge.textContent = `${monitors.length} 個任務`;

        // 若無監控任務，顯示預設 Placeholder
        if (monitors.length === 0) {
            emptyState.style.display = 'flex';
            
            // 移除舊的卡片
            const cards = monitorsGrid.querySelectorAll('.monitor-card');
            cards.forEach(card => card.remove());
            return;
        }

        emptyState.style.display = 'none';

        // 建立或更新卡片
        // 為了平滑渲染，先收集現有的卡片 ID
        const existingCardIds = Array.from(monitorsGrid.querySelectorAll('.monitor-card'))
            .map(card => card.dataset.id);

        // 被刪除的卡片需要移除
        const currentIds = monitors.map(m => m.id);
        existingCardIds.forEach(id => {
            if (!currentIds.includes(id)) {
                const cardToRemove = monitorsGrid.querySelector(`.monitor-card[data-id="${id}"]`);
                if (cardToRemove) cardToRemove.remove();
            }
        });

        // 渲染或更新每一個監控卡片
        monitors.forEach(monitor => {
            let card = monitorsGrid.querySelector(`.monitor-card[data-id="${monitor.id}"]`);
            const isNew = !card;

            if (isNew) {
                card = document.createElement('div');
                card.className = 'monitor-card';
                card.dataset.id = monitor.id;
                if (monitor.isMock) {
                    card.classList.add('mock-border');
                }
            }

            // 計算目前號碼與目標號碼差額
            const currentSeqVal = parseInt(monitor.currentSeq);
            const targetVal = monitor.targetNumber;
            const threshold = monitor.alertThreshold;

            let diffText = '-';
            let estWaitText = '-';
            let numColorClass = '';
            let badgeClass = 'badge-waiting';
            let statusLabel = monitor.status;

            if (!isNaN(currentSeqVal)) {
                const diff = targetVal - currentSeqVal;
                
                if (currentSeqVal === targetVal) {
                    diffText = '已到號';
                    estWaitText = '立即就診';
                    numColorClass = 'danger-color';
                    badgeClass = 'badge-urgent';
                    statusLabel = '現在到您了';
                } else if (diff > 0) {
                    diffText = `剩餘 ${diff} 人`;
                    estWaitText = `${diff * 3} 分鐘`;
                    
                    if (diff <= threshold) {
                        numColorClass = 'warning-color';
                        badgeClass = 'badge-alert';
                        statusLabel = '即將到號';
                    } else {
                        numColorClass = '';
                        badgeClass = 'badge-waiting';
                        statusLabel = '排隊中';
                    }
                } else {
                    diffText = '已過號';
                    estWaitText = '需去診間報到';
                    numColorClass = 'muted-color';
                    badgeClass = 'badge-missed';
                    statusLabel = '已過號';
                }
            } else {
                // 非數字狀態 (如: 休診、結束看診、讀取中)
                diffText = monitor.currentSeq;
                estWaitText = '-';
                numColorClass = 'muted-color';
                badgeClass = 'badge-finished';
                
                if (monitor.currentSeq === '結束看診') {
                    statusLabel = '結束看診';
                } else if (monitor.currentSeq === '休診') {
                    statusLabel = '休診';
                }
            }

            // 卡片 HTML 內容填充
            card.innerHTML = `
                <div class="card-top">
                    <div class="card-title-group">
                        <h3>${monitor.clinicName}</h3>
                        <p>${monitor.deptName} • ${formatNoon(monitor.noon)}</p>
                    </div>
                    <span class="card-badge ${badgeClass}">${statusLabel}</span>
                </div>
                
                <div class="card-body">
                    <div class="doctor-info">
                        <span class="doctor-name"><i class="fa-solid fa-user-md"></i> ${monitor.doctorName} 醫師</span>
                        <div class="target-info">
                            <span>您的號碼:</span>
                            <span class="target-num-badge">${monitor.targetNumber} 號</span>
                        </div>
                    </div>
                    <div class="queue-number-box">
                        <span class="number-label">目前叫號</span>
                        <span class="number-val ${numColorClass}">${monitor.currentSeq}</span>
                    </div>
                </div>
                
                <div class="card-bottom-info">
                    <div class="people-left">
                        <i class="fa-solid fa-users"></i> 進度：<strong>${diffText}</strong>
                    </div>
                    <div class="time-est">
                        <i class="fa-solid fa-hourglass-half"></i> 估計等待：<strong>${estWaitText}</strong>
                    </div>
                </div>
                
                <div class="card-controls">
                    <span class="update-time"><i class="fa-solid fa-rotate"></i> ${monitor.lastUpdated}</span>
                    <div class="controls-buttons">
                        ${monitor.isMock ? `
                            <button class="mock-control-btn btn-down" title="模擬診號遞減">
                                <i class="fa-solid fa-chevron-left"></i>
                            </button>
                            <button class="mock-control-btn btn-up" title="模擬診號遞增">
                                <i class="fa-solid fa-chevron-right"></i>
                            </button>
                        ` : ''}
                        <button class="btn btn-danger btn-icon btn-delete" title="停止監控並刪除">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>
            `;

            // 設定按鈕事件監聽器
            const btnDelete = card.querySelector('.btn-delete');
            btnDelete.onclick = () => deleteMonitor(monitor.id);

            if (monitor.isMock) {
                const btnDown = card.querySelector('.btn-down');
                const btnUp = card.querySelector('.btn-up');
                
                btnDown.onclick = () => tickMockMonitor(monitor.id, 'down');
                btnUp.onclick = () => tickMockMonitor(monitor.id, 'up');
            }

            if (isNew) {
                monitorsGrid.appendChild(card);
            }
        });
    }

    // 格式化午別文字
    function formatNoon(noon) {
        if (noon === 'AM') return '上午診';
        if (noon === 'PM') return '下午診';
        if (noon === 'Night') return '夜間診';
        return noon;
    }

    // 7. API：新增監控任務
    monitorForm.onsubmit = async (e) => {
        e.preventDefault();

        const deptCode = deptSelect.value;
        const noon = noonSelect.value;
        
        // 診間名稱判斷：若是自訂則取輸入框的值，否則取下拉選單的值
        let clinicName = '';
        if (clinicSelect.value === '__custom__') {
            clinicName = clinicInput.value.trim();
        } else {
            clinicName = clinicSelect.value;
        }

        const doctorName = doctorInput.value.trim();
        const targetNumber = targetNumberInput.value;
        const alertThreshold = thresholdInput.value;
        const isMock = mockModeCheckbox.checked;

        if (!deptCode || !noon || !clinicName || !targetNumber) {
            alert('請完整填寫所有必要欄位，並確認診間名稱已輸入！');
            return;
        }

        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 初始化監控中...';

        try {
            const response = await fetch('/api/monitors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deptCode,
                    noon,
                    clinicName,
                    doctorName,
                    targetNumber,
                    alertThreshold,
                    isMock
                })
            });

            if (response.ok) {
                // 新增成功，清空掛號號碼輸入框，方便下次填寫
                targetNumberInput.value = '';
                // 提示通知權限（如果尚未開啟）
                if ('Notification' in window && Notification.permission === 'default') {
                    Notification.requestPermission();
                }
            } else {
                const errData = await response.json();
                alert(`建立監控失敗: ${errData.error}`);
            }
        } catch (err) {
            console.error('送出監控失敗:', err);
            alert('無法與伺服器連線，請確認後端是否正常運作。');
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.innerHTML = '<i class="fa-solid fa-play"></i> 開始監控進度';
        }
    };

    // 8. API：刪除監控任務
    async function deleteMonitor(id) {
        if (!confirm('您確定要停止監控此診間並刪除任務嗎？')) return;

        try {
            const res = await fetch(`/api/monitors/${id}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json();
                alert(`刪除失敗: ${err.error}`);
            }
        } catch (err) {
            console.error('刪除監控任務失敗:', err);
        }
    }

    // 9. API：模擬診號手動跳號 (模擬模式)
    async function tickMockMonitor(id, direction) {
        try {
            await fetch(`/api/monitors/${id}/mock-tick`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ direction })
            });
        } catch (err) {
            console.error('調校模擬診號失敗:', err);
        }
    }

    // 10. API：測試通知按鈕點擊
    btnTestNotify.onclick = async () => {
        btnTestNotify.disabled = true;
        btnTestNotify.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 發送中...';
        
        // 請求本地通知權限
        if ('Notification' in window && Notification.permission !== 'granted') {
            await Notification.requestPermission();
        }

        try {
            const res = await fetch('/api/test-notification', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                console.log('測試通知發送成功！');
            } else {
                alert('測試通知發送失敗！');
            }
        } catch (err) {
            console.error('測試通知發送出錯:', err);
            alert('發送測試通知失敗，請確認伺服器連線。');
        } finally {
            btnTestNotify.disabled = false;
            btnTestNotify.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 測試通知';
        }
    };
});
