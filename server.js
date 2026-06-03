// 載入必要的模組
const express = require('express');
const https = require('https');
const querystring = require('querystring');
const dotenv = require('dotenv');
const path = require('path');

// 載入環境變數設定
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL_MS) || 60000;

// 啟用 JSON 與 URL-encoded 解析
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 儲存所有監控任務的陣列
// 每個任務的格式包含：id, deptCode, deptName, noon, clinicName, doctorName, targetNumber, alertThreshold, currentSeq, status, lastUpdated, notificationSent, completed, isMock, mockSeq
let monitors = [];

// 儲存所有連接的 SSE 用戶端
let sseClients = [];

// 定義高醫科別代碼對照表
const DEPARTMENTS = {
    '0100': '內科部',
    '0200': '外科部',
    '0300': '婦產部',
    '0400': '小兒部',
    '0500': '眼科部',
    '0600': '耳鼻喉部',
    '0700': '骨科部',
    '0800': '泌尿部',
    '0900': '皮膚部',
    '1000': '神經部',
    '1100': '精神醫學部',
    '1200': '放射腫瘤部',
    '1300': '牙科部',
    '1500': '家庭醫學科',
    '1600': '急診部',
    '1700': '疼痛科',
    '1800': '復健部',
    '1900': '健康管理中心',
    '2100': '職業及環境醫學科'
};

// 輔助函式：發送事件給所有連線的前端
function broadcastUpdate() {
    console.log(`正在向 ${sseClients.length} 個用戶端推播更新...`);
    sseClients.forEach(client => {
        client.write(`data: ${JSON.stringify(monitors)}\n\n`);
    });
}

// 輔助函式：發送 Discord Webhook 通知
function sendDiscordNotification(message) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        console.log('未設定 DISCORD_WEBHOOK_URL，跳過 Discord 通知。');
        return;
    }

    const payload = JSON.stringify({ content: message });
    const parsedUrl = new URL(webhookUrl);

    const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = https.request(options, (res) => {
        console.log(`Discord 通知送出，狀態碼: ${res.statusCode}`);
        // 釋放回應串流以釋放 underlying socket 連線，避免記憶體洩漏與連線懸掛
        res.resume();
    });

    req.on('error', (err) => {
        console.error('Discord 通知發送失敗:', err.message);
    });

    req.write(payload);
    req.end();
}

// 輔助函式：發送 Telegram Bot 通知
function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.log('未設定 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，跳過 Telegram 通知。');
        return;
    }

    const payload = JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
    });

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = https.request(options, (res) => {
        console.log(`Telegram 通知送出，狀態碼: ${res.statusCode}`);
        // 釋放回應串流以釋放 underlying socket 連線，避免記憶體洩漏與連線懸掛
        res.resume();
    });

    req.on('error', (err) => {
        console.error('Telegram 通知發送失敗:', err.message);
    });

    req.write(payload);
    req.end();
}

// 輔助函式：整合所有通知管道
function triggerAlert(monitor, title, description) {
    const formattedTime = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    const fullMessage = `🔔 *[高醫看診進度通知]* 🔔\n\n📌 *診間*: ${monitor.clinicName} (${monitor.doctorName} 醫師)\n🔢 *您的號碼*: ${monitor.targetNumber} 號\n📈 *目前進度*: ${monitor.currentSeq} 號\n📢 *狀態*: ${description}\n⏰ *時間*: ${formattedTime}`;
    
    console.log(`發送通知: ${title} - ${description}`);
    sendDiscordNotification(fullMessage);
    sendTelegramNotification(fullMessage);
    
    // 向前端發送特定警報事件 (可由前端播放音效)
    sseClients.forEach(client => {
        client.write(`event: alert\ndata: ${JSON.stringify({ id: monitor.id, title, description })}\n\n`);
    });
}

// 爬蟲核心函式：向高醫請求看診進度並解析
function fetchClinicProgress(deptCode, noon, clinicName, doctorName) {
    return new Promise((resolve, reject) => {
        const url = 'https://www.kmuh.org.tw/Web/WebRegistration/OPDSeq/GetSeqDetial';
        const postData = querystring.stringify({
            VirtualDept: deptCode,
            Noon: noon
        });

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(url, options, (res) => {
            let html = '';
            res.on('data', (chunk) => html += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`伺服器回應錯誤碼: ${res.statusCode}`));
                }

                // 使用正則表達式解析所有的診間卡片
                const clinicRegex = /<div[^>]*class="[^"]*c_table[^"]*"[^>]*data-dept="([^"]+)"[^>]*data-dname="([^"]+)"[\s\S]*?<span[^>]*class="DocName"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*class="TakeDocName"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*class="Title\s+OrderStatus"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*class="Title\s+CurrentSeq"[^>]*>([\s\S]*?)<\/span>/g;
                
                let match;
                let foundMatch = null;

                while ((match = clinicRegex.exec(html)) !== null) {
                    const parsedDeptCode = match[1].trim();
                    const parsedClinicName = match[2].trim();
                    const parsedDoctor = match[3].trim();
                    const parsedSubDoctor = match[4].trim();
                    const parsedStatus = match[5].trim();
                    const parsedSeq = match[6].trim();

                    // 比對條件：診間名稱包含使用者輸入的診間名稱（例如 "一般醫學內科1診"）
                    // 或者是診間代碼相同
                    if (parsedClinicName === clinicName || parsedDeptCode === clinicName || parsedClinicName.includes(clinicName)) {
                        foundMatch = {
                            deptCode: parsedDeptCode,
                            clinicName: parsedClinicName,
                            doctorName: parsedDoctor || parsedSubDoctor || '未指定',
                            status: parsedStatus,
                            currentSeq: parsedSeq
                        };
                        break;
                    }
                }

                if (foundMatch) {
                    resolve(foundMatch);
                } else {
                    reject(new Error(`找不到指定的診間: ${clinicName}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.write(postData);
        req.end();
    });
}

// 更新單一監控任務狀態並判斷是否需要警報
async function updateMonitor(monitor) {
    const formattedTime = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    
    // 如果是模擬模式，由前端或模擬 API 來更新，此處跳過高醫爬蟲
    if (monitor.isMock) {
        const currentVal = parseInt(monitor.currentSeq);
        const targetVal = monitor.targetNumber;
        
        if (!isNaN(currentVal)) {
            const diff = targetVal - currentVal;
            if (currentVal === targetVal) {
                monitor.status = '現在到您了';
                if (!monitor.arrivedAlertSent) {
                    triggerAlert(monitor, '已到號', `現在輪到您的號碼了 (${targetVal} 號)！請立即進入診間看診。`);
                    monitor.arrivedAlertSent = true;
                }
            } else if (diff > 0 && diff <= monitor.alertThreshold) {
                monitor.status = '即將到號';
                if (!monitor.approachingAlertSent) {
                    triggerAlert(monitor, '即將到號', `目前為 ${currentVal} 號，距離您的號碼 ${targetVal} 號還剩 ${diff} 人，請準備前往診間！`);
                    monitor.approachingAlertSent = true;
                }
            } else if (currentVal > targetVal) {
                monitor.status = '已過號';
            } else {
                monitor.status = '排隊中';
            }
        }
        monitor.lastUpdated = formattedTime;
        return;
    }

    try {
        const result = await fetchClinicProgress(monitor.deptCode, monitor.noon, monitor.clinicName, monitor.doctorName);
        monitor.currentSeq = result.currentSeq;
        monitor.lastUpdated = formattedTime;
        
        // 更新醫生姓名（以高醫即時資訊為準）
        if (result.doctorName && result.doctorName !== '未指定') {
            monitor.doctorName = result.doctorName;
        }

        const seqStr = result.currentSeq;
        const seqVal = parseInt(seqStr);
        const targetVal = monitor.targetNumber;

        if (seqStr === '結束看診' || seqStr.includes('結束')) {
            monitor.status = '結束看診';
            monitor.completed = true;
            triggerAlert(monitor, '結束看診', `此診間今日看診已結束。`);
        } else if (seqStr === '休診') {
            monitor.status = '休診';
            monitor.completed = true;
            triggerAlert(monitor, '休診', `此診間今日休診。`);
        } else if (!isNaN(seqVal)) {
            const diff = targetVal - seqVal;
            if (seqVal === targetVal) {
                monitor.status = '現在到您了';
                if (!monitor.arrivedAlertSent) {
                    triggerAlert(monitor, '已到號', `現在輪到您的號碼了 (${targetVal} 號)！請立即進入診間。`);
                    monitor.arrivedAlertSent = true;
                }
            } else if (diff > 0 && diff <= monitor.alertThreshold) {
                monitor.status = '即將到號';
                if (!monitor.approachingAlertSent) {
                    triggerAlert(monitor, '即將到號', `目前為 ${seqVal} 號，距離您的號碼 ${targetVal} 號還剩 ${diff} 人，請準備前往診間！`);
                    monitor.approachingAlertSent = true;
                }
            } else if (seqVal > targetVal) {
                monitor.status = '已過號';
            } else {
                monitor.status = '排隊中';
            }
        } else {
            monitor.status = result.status || '看診中';
        }
    } catch (err) {
        console.error(`更新監控任務 [${monitor.clinicName}] 失敗:`, err.message);
        monitor.status = '抓取失敗';
        monitor.lastUpdated = formattedTime;
    }
}

// 輔助函式：取得特定科別與時段的所有診間清單
function fetchClinicsForDept(deptCode, noon) {
    return new Promise((resolve, reject) => {
        const url = 'https://www.kmuh.org.tw/Web/WebRegistration/OPDSeq/GetSeqDetial';
        const postData = querystring.stringify({
            VirtualDept: deptCode,
            Noon: noon
        });

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(url, options, (res) => {
            let html = '';
            res.on('data', (chunk) => html += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`伺服器回應錯誤碼: ${res.statusCode}`));
                }

                const clinicRegex = /<div[^>]*class="[^"]*c_table[^"]*"[^>]*data-dept="([^"]+)"[^>]*data-dname="([^"]+)"[\s\S]*?<span[^>]*class="DocName"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*class="TakeDocName"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*class="Title\s+OrderStatus"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span[^>]*class="Title\s+CurrentSeq"[^>]*>([\s\S]*?)<\/span>/g;
                
                let match;
                const clinics = [];

                while ((match = clinicRegex.exec(html)) !== null) {
                    const parsedDeptCode = match[1].trim();
                    const parsedClinicName = match[2].trim();
                    const parsedDoctor = match[3].trim();
                    const parsedSubDoctor = match[4].trim();
                    const parsedStatus = match[5].trim();
                    const parsedSeq = match[6].trim();

                    clinics.push({
                        deptCode: parsedDeptCode,
                        clinicName: parsedClinicName,
                        doctorName: parsedDoctor || parsedSubDoctor || '未指定',
                        status: parsedStatus,
                        currentSeq: parsedSeq
                    });
                }
                resolve(clinics);
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.write(postData);
        req.end();
    });
}

// 背景輪詢排程：定時更新所有監控任務並廣播給前端
setInterval(async () => {
    if (monitors.length === 0) return;
    
    console.log('背景輪詢：開始更新所有監控中的診間進度...');
    for (let monitor of monitors) {
        if (!monitor.completed) {
            await updateMonitor(monitor);
        }
    }
    broadcastUpdate();
}, MONITOR_INTERVAL);

// ==================== API 路由實作 ====================

// 1. 取得科別代碼對照表
app.get('/api/depts', (req, res) => {
    res.json(DEPARTMENTS);
});

// 1.5 取得指定科別與時段的診間列表 (用於前端防呆選單)
app.get('/api/clinics', async (req, res) => {
    const { deptCode, noon } = req.query;
    if (!deptCode || !noon) {
        return res.status(400).json({ error: '請提供 deptCode 與 noon 參數' });
    }
    try {
        const clinics = await fetchClinicsForDept(deptCode, noon);
        res.json(clinics);
    } catch (err) {
        console.error('取得診間列表失敗:', err.message);
        res.status(500).json({ error: '無法自高醫取得診間列表，請嘗試手動輸入' });
    }
});

// 2. 取得所有監控中的任務
app.get('/api/monitors', (req, res) => {
    res.json(monitors);
});

// 3. 新增監控任務
app.post('/api/monitors', async (req, res) => {
    const { deptCode, noon, clinicName, doctorName, targetNumber, alertThreshold, isMock } = req.body;

    if (!deptCode || !noon || !clinicName || !targetNumber) {
        return res.status(400).json({ error: '欄位填寫不完整，請確認 deptCode, noon, clinicName, targetNumber 皆有填寫' });
    }

    const id = Date.now().toString();
    const formattedTime = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    
    const newMonitor = {
        id,
        deptCode,
        deptName: DEPARTMENTS[deptCode] || '未知科別',
        noon,
        clinicName: clinicName.trim(),
        doctorName: (doctorName || '').trim() || '未指定',
        targetNumber: parseInt(targetNumber),
        alertThreshold: parseInt(alertThreshold) || 3,
        currentSeq: isMock ? '1' : '讀取中',
        status: isMock ? '模擬排隊中' : '初始化',
        lastUpdated: formattedTime,
        approachingAlertSent: false,
        arrivedAlertSent: false,
        completed: false,
        isMock: !!isMock
    };

    // 立即抓取一次最新進度（如果是真實模式的話）
    if (!newMonitor.isMock) {
        try {
            const result = await fetchClinicProgress(newMonitor.deptCode, newMonitor.noon, newMonitor.clinicName, newMonitor.doctorName);
            newMonitor.currentSeq = result.currentSeq;
            
            // 更新真實的診間名稱與醫生名
            newMonitor.clinicName = result.clinicName;
            if (result.doctorName && result.doctorName !== '未指定') {
                newMonitor.doctorName = result.doctorName;
            }

            const seqVal = parseInt(newMonitor.currentSeq);
            if (!isNaN(seqVal)) {
                const diff = newMonitor.targetNumber - seqVal;
                if (seqVal === newMonitor.targetNumber) {
                    newMonitor.status = '現在到您了';
                    newMonitor.arrivedAlertSent = true;
                    newMonitor.approachingAlertSent = true;
                } else if (diff > 0 && diff <= newMonitor.alertThreshold) {
                    newMonitor.status = '即將到號';
                    newMonitor.approachingAlertSent = true;
                } else if (seqVal > newMonitor.targetNumber) {
                    newMonitor.status = '已過號';
                } else {
                    newMonitor.status = '排隊中';
                }
            } else {
                newMonitor.status = result.status || '看診中';
            }
        } catch (err) {
            console.log('首次初始抓取失敗:', err.message);
            newMonitor.status = '初始化失敗';
        }
    } else {
        // 模擬模式初始邏輯
        const diff = newMonitor.targetNumber - 1;
        if (diff > 0 && diff <= newMonitor.alertThreshold) {
            newMonitor.status = '即將到號';
            newMonitor.approachingAlertSent = true;
        } else if (newMonitor.targetNumber === 1) {
            newMonitor.status = '現在到您了';
            newMonitor.arrivedAlertSent = true;
            newMonitor.approachingAlertSent = true;
        } else {
            newMonitor.status = '排隊中';
        }
    }

    monitors.push(newMonitor);
    console.log(`新增監控任務成功: ${newMonitor.clinicName}`);
    
    // 發送監控啟動確認通知至 Discord/Telegram，給予照護者安心確認
    const initMessage = `📢 *[高醫看診監控已啟動]*\n\n📌 *診間*: ${newMonitor.clinicName} (${newMonitor.doctorName} 醫師)\n🔢 *您的號碼*: ${newMonitor.targetNumber} 號\n📈 *目前進度*: ${newMonitor.currentSeq} 號\n🔔 *提醒設定*: 提前 ${newMonitor.alertThreshold} 號通知\n⚙️ *模式*: ${newMonitor.isMock ? '🧪 模擬模式' : '🏥 即時監控'}`;
    sendDiscordNotification(initMessage);
    sendTelegramNotification(initMessage);
    
    // 通知所有客戶端
    broadcastUpdate();
    res.status(201).json(newMonitor);
});

// 4. 刪除監控任務
app.delete('/api/monitors/:id', (req, res) => {
    const { id } = req.params;
    const initialLength = monitors.length;
    monitors = monitors.filter(m => m.id !== id);

    if (monitors.length < initialLength) {
        console.log(`刪除監控任務成功: ID = ${id}`);
        broadcastUpdate();
        return res.json({ success: true, message: '已移除監控任務' });
    } else {
        return res.status(404).json({ error: '找不到該監控任務' });
    }
});

// 5. 測試通知接口 (Discord, Telegram, SSE Web Alert)
app.post('/api/test-notification', (req, res) => {
    const testMessage = '🔔 *[高醫看診進度通知 - 測試功能]*\n這是一則測試通知，代表您的 Discord / Telegram / SSE 通知連線設定成功！';
    
    console.log('發送系統測試通知中...');
    sendDiscordNotification(testMessage);
    sendTelegramNotification(testMessage);

    // 同步向所有 SSE 用戶端發送測試警報
    sseClients.forEach(client => {
        client.write(`event: alert\ndata: ${JSON.stringify({ id: 'test', title: '系統測試通知', description: '通知管道連接測試成功！' })}\n\n`);
    });

    res.json({ success: true, message: '測試通知已發送至所有設定的管道' });
});

// 6. 模擬模式下的診號調整 API (手動微調號碼以供測試)
app.post('/api/monitors/:id/mock-tick', async (req, res) => {
    const { id } = req.params;
    const { direction } = req.body; // 'up' or 'down'

    const monitor = monitors.find(m => m.id === id);
    if (!monitor) {
        return res.status(404).json({ error: '找不到指定的監控任務' });
    }

    if (!monitor.isMock) {
        return res.status(400).json({ error: '該診間非模擬監控模式，無法調整號碼' });
    }

    let currentVal = parseInt(monitor.currentSeq);
    if (isNaN(currentVal)) currentVal = 1;

    if (direction === 'up') {
        currentVal++;
    } else if (direction === 'down' && currentVal > 1) {
        currentVal--;
    }

    monitor.currentSeq = currentVal.toString();
    await updateMonitor(monitor);
    broadcastUpdate();

    res.json(monitor);
});

// 7. 伺服器發送事件 (SSE) 連線點，供前端進行即時單向推送
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    console.log('前端客戶端已成功連接至即時更新通道 (SSE)');
    sseClients.push(res);

    // 首次連線時立即傳送目前的監控清單
    res.write(`data: ${JSON.stringify(monitors)}\n\n`);

    // 連線中斷時清除該連線
    req.on('close', () => {
        console.log('前端連線中斷，正在清除 SSE 用戶端');
        sseClients = sseClients.filter(client => client !== res);
    });
});

// 啟動伺服器並監聽埠號
app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`高醫看診進度通知器後端已成功啟動！`);
    console.log(`本地網址: http://localhost:${PORT}`);
    console.log(`輪詢間隔: ${MONITOR_INTERVAL / 1000} 秒`);
    console.log(`========================================`);
});
