// ============================================================
// 插件：AI 玩具控制 v6.0 (ANKNI MX)
// 功能：
//   1. 解析 char 消息中的 <vi> 标签，自动控制 ANKNI MX 蓝牙玩具
//   2. 双电机独立控制（吮吸 + 震动），支持序列播放
//   3. 聊天会话绑定，实时监控新消息
//   4. 手动控制 + 向绑定会话注入用户消息
//   5. 后台运行，页面切换不中断
// 协议：AA 01 02 [吮吸] [震动] [校验和]，校验和 = 前5字节之和 & 0xFF
// ============================================================
(function() {
  'use strict';

  // ============================================================
  // 蓝牙协议常量（ANKNI MX 已确认）
  // ============================================================
  const SERVICE_UUID = '0000dddd-0000-1000-8000-00805f9b34fb';
  const WRITE_UUID   = '0000ddd1-0000-1000-8000-00805f9b34fb';
  const NOTIFY_UUID  = '0000ddd2-0000-1000-8000-00805f9b34fb';
  const DEVICE_NAME  = 'ANKNI MX';

  // 轮询间隔
  const POLL_FOREGROUND = 1500; // 前台 1.5 秒
  const POLL_BACKGROUND = 3000; // 后台 3 秒

  // ============================================================
  // 全局状态
  // ============================================================
  const state = {
    // 蓝牙
    device: null,
    server: null,
    writeChar: null,
    notifyChar: null,
    isConnected: false,

    // Roche
    roche: null,
    container: null,

    // 设置（持久化）
    boundConvId: '',
    autoMonitor: false,
    lastProcessedTs: 0,

    // 监控
    monitorInterval: null,
    isMonitoring: false,
    currentUserPersonaId: null,

    // 序列播放器
    sequenceGen: 0,         // 代际计数器，用于取消旧序列
    currentSequence: null,  // { steps, index, source }

    // 当前值
    currentSuction: 0,
    currentVibration: 0,

    // Notify 数据
    lastNotifyData: null,

    // UI 回调
    onStatusChange: null,
    onLastCmdChange: null,
    onNotifyData: null,
    onSequenceChange: null,
    onValuesChange: null,

    // 清理追踪
    cleanup: { listeners: [], intervals: [], timeouts: [], visibilityHandler: null }
  };

  // ============================================================
  // 工具函数
  // ============================================================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function formatHex(data) {
    return Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  // 注册清理项
  function trackListener(target, event, handler) {
    target.addEventListener(event, handler);
    state.cleanup.listeners.push({ target, event, handler });
  }
  function trackInterval(fn, ms) {
    const id = setInterval(fn, ms);
    state.cleanup.intervals.push(id);
    return id;
  }
  function trackTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    state.cleanup.timeouts.push(id);
    return id;
  }

  // ============================================================
  // 指令构建（ANKNI MX 协议）
  // ============================================================
  function buildCommand(suction, vibration) {
    const s = Math.max(0, Math.min(parseInt(suction, 10) || 0, 9));
    const v = Math.max(0, Math.min(parseInt(vibration, 10) || 0, 9));
    const data = [0xAA, 0x01, 0x02, s, v];
    let sum = 0;
    for (const b of data) sum = (sum + b) & 0xFF;
    data.push(sum);
    return new Uint8Array(data);
  }

  function buildStopCommand() {
    // AA 01 02 00 00 AD
    return buildCommand(0, 0);
  }

  // 解析 Notify 数据
  function parseNotify(data) {
    if (!data || data.length < 5 || data[0] !== 0xAA) return null;
    let calcSum = 0;
    for (let i = 0; i < data.length - 1; i++) calcSum = (calcSum + data[i]) & 0xFF;
    if (calcSum !== data[data.length - 1]) return { checksumError: true, raw: formatHex(data) };
    return {
      header: data[0],
      cmd: data[1],
      len: data[2],
      payload: Array.from(data.slice(3, 3 + data[2])),
      raw: formatHex(data)
    };
  }

  // ============================================================
  // <vi> 标签解析
  // 格式：
  //   <vi s="3" v="2"/>        设置吮吸3 震动2
  //   <vi s="3" v="2" d="5"/>  设置吮吸3 震动2，持续5秒后执行下一个
  //   <vi s="0" v="2"/>        只有震动
  //   <vi stop/>               停止所有
  // ============================================================
  function parseViTags(text) {
    if (!text) return [];
    const steps = [];
    const regex = /<vi\s+([^/>]*?)\s*\/?>/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const attrs = match[1] || '';
      // 停止指令
      if (/\bstop\b/i.test(attrs)) {
        steps.push({ type: 'stop', suction: 0, vibration: 0, duration: 0 });
        continue;
      }
      const sMatch = attrs.match(/\bs\s*=\s*["']?(\d+)["']?/i);
      const vMatch = attrs.match(/\bv\s*=\s*["']?(\d+)["']?/i);
      const dMatch = attrs.match(/\bd\s*=\s*["']?(\d+)["']?/i);
      const s = sMatch ? parseInt(sMatch[1], 10) : 0;
      const v = vMatch ? parseInt(vMatch[1], 10) : 0;
      const d = dMatch ? parseInt(dMatch[1], 10) : 0;
      // 至少要有 s 或 v 属性才算有效
      if (sMatch || vMatch) {
        steps.push({ type: 'set', suction: s, vibration: v, duration: d });
      }
    }
    return steps;
  }

  // ============================================================
  // 状态更新通知
  // ============================================================
  function updateStatus(text, isError) {
    if (state.onStatusChange) state.onStatusChange(text, isError);
  }

  function updateLastCmd(text) {
    if (state.onLastCmdChange) state.onLastCmdChange(text);
  }

  function updateSequenceStatus(text) {
    if (state.onSequenceChange) state.onSequenceChange(text);
  }

  function updateValues(suction, vibration) {
    state.currentSuction = suction;
    state.currentVibration = vibration;
    if (state.onValuesChange) state.onValuesChange(suction, vibration);
  }

  // ============================================================
  // 蓝牙连接管理
  // ============================================================
  async function connectBluetooth() {
    try {
      updateStatus('正在搜索蓝牙设备...');
      const dev = await navigator.bluetooth.requestDevice({
        filters: [{ name: DEVICE_NAME }],
        optionalServices: [SERVICE_UUID]
      });
      state.device = dev;
      updateStatus('正在连接 GATT...');

      dev.addEventListener('gattserverdisconnected', onDisconnected);
      state.cleanup.listeners.push({ target: dev, event: 'gattserverdisconnected', handler: onDisconnected });

      state.server = await dev.gatt.connect();
      updateStatus('正在获取服务...');
      await setupCharacteristics();
      await setupNotifyListener();
      state.isConnected = true;
      updateStatus('✅ 已连接: ' + DEVICE_NAME);

      if (state.autoMonitor && state.boundConvId) startMonitor();
      return true;
    } catch (e) {
      updateStatus('❌ 连接失败: ' + e.message, true);
      state.isConnected = false;
      return false;
    }
  }

  function onDisconnected() {
    state.isConnected = false;
    state.writeChar = null;
    state.notifyChar = null;
    cancelSequence();
    updateStatus('蓝牙已断开连接', true);
  }

  async function setupCharacteristics() {
    if (!state.server) return;
    state.writeChar = null;
    state.notifyChar = null;
    try {
      const svc = await state.server.getPrimaryService(SERVICE_UUID);
      state.writeChar = await svc.getCharacteristic(WRITE_UUID);
      try {
        state.notifyChar = await svc.getCharacteristic(NOTIFY_UUID);
      } catch (e) {
        state.notifyChar = null;
      }
    } catch (e) {
      throw new Error('获取 ANKNI MX 服务失败: ' + e.message);
    }
  }

  async function setupNotifyListener() {
    if (!state.notifyChar) return;
    try {
      await state.notifyChar.startNotifications();
      const handler = (event) => {
        const data = new Uint8Array(event.target.value.buffer);
        state.lastNotifyData = data;
        const parsed = parseNotify(data);
        if (state.onNotifyData) state.onNotifyData(parsed || { raw: formatHex(data) });
      };
      state.notifyChar.addEventListener('characteristicvaluechanged', handler);
      state.cleanup.listeners.push({ target: state.notifyChar, event: 'characteristicvaluechanged', handler });
    } catch (e) {
      console.log('Notify 订阅失败:', e);
    }
  }

  function disconnectBluetooth() {
    stopMonitor();
    cancelSequence();
    if (state.device && state.device.gatt && state.device.gatt.connected) {
      state.device.gatt.disconnect();
    }
    state.device = null;
    state.server = null;
    state.writeChar = null;
    state.notifyChar = null;
    state.isConnected = false;
    state.lastNotifyData = null;
    updateStatus('已断开');
  }

  // 发送指令到玩具
  async function sendCmd(suction, vibration) {
    if (!state.isConnected || !state.writeChar) {
      updateStatus('未连接蓝牙', true);
      return false;
    }
    try {
      const data = buildCommand(suction, vibration);
      if (state.writeChar.properties.writeWithoutResponse) {
        await state.writeChar.writeValueWithoutResponse(data);
      } else if (state.writeChar.properties.write) {
        await state.writeChar.writeValue(data);
      } else {
        updateStatus('特征值不支持写入', true);
        return false;
      }
      return true;
    } catch (e) {
      updateStatus('发送失败: ' + e.message, true);
      return false;
    }
  }

  async function sendStop() {
    if (!state.isConnected || !state.writeChar) return false;
    try {
      const data = buildStopCommand();
      if (state.writeChar.properties.writeWithoutResponse) {
        await state.writeChar.writeValueWithoutResponse(data);
      } else if (state.writeChar.properties.write) {
        await state.writeChar.writeValue(data);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ============================================================
  // 序列播放器
  // 一条消息中可能有多个 <vi> 标签，按顺序播放
  // 有 d 属性则等待指定秒数后执行下一个；无 d 则立即执行并保持
  // 新消息到来或用户手动控制时，取消当前序列
  // ============================================================
  function cancelSequence() {
    state.sequenceGen++; // 让所有正在 await 的序列失效
    state.currentSequence = null;
    updateSequenceStatus('空闲');
  }

  async function playSequence(steps, source) {
    cancelSequence(); // 取消旧序列
    if (!steps || steps.length === 0) return;
    const myGen = state.sequenceGen;
    state.currentSequence = { steps, index: 0, source };

    for (let i = 0; i < steps.length; i++) {
      // 被取消则退出
      if (myGen !== state.sequenceGen) return;
      state.currentSequence.index = i;
      const step = steps[i];
      updateSequenceStatus(`播放序列 ${i + 1}/${steps.length}（来源：${source}）`);

      if (step.type === 'stop') {
        await sendStop();
        updateValues(0, 0);
        updateLastCmd(`序列 [${i + 1}/${steps.length}] 停止`);
      } else {
        const ok = await sendCmd(step.suction, step.vibration);
        if (ok) {
          updateValues(step.suction, step.vibration);
          updateLastCmd(`序列 [${i + 1}/${steps.length}] 吸${step.suction} 震${step.vibration}`);
        }
      }

      // 被取消则退出
      if (myGen !== state.sequenceGen) return;

      // 如果有持续时间且不是最后一个，则等待
      if (step.duration > 0 && i < steps.length - 1) {
        updateSequenceStatus(`序列 [${i + 1}/${steps.length}] 保持 ${step.duration}秒...`);
        await sleep(step.duration * 1000);
        if (myGen !== state.sequenceGen) return;
      }
    }

    if (myGen === state.sequenceGen) {
      state.currentSequence = null;
      updateSequenceStatus('序列播放完成');
    }
  }

  // ============================================================
  // 消息注入（直接操作 IndexedDB）
  // 模拟用户消息写入，这样 char 下次回复时能看到
  // ============================================================
  async function injectUserMessage(conversationId, text) {
    if (!conversationId) return null;
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open('Roche_db');
        req.onsuccess = () => {
          const db = req.result;
          let tx, store;
          try {
            tx = db.transaction('messages', 'readwrite');
            store = tx.objectStore('messages');
          } catch (e) {
            reject(new Error('打开 messages 仓库失败: ' + e.message));
            return;
          }
          const msg = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            isMe: true,
            text: text,
            type: 'text',
            timestamp: Date.now(),
            conversationId: conversationId
          };
          const addReq = store.add(msg);
          addReq.onsuccess = () => resolve(msg.id);
          addReq.onerror = () => reject(addReq.error);
        };
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
    });
  }

  // ============================================================
  // 消息监控
  // ============================================================
  async function checkMessages() {
    if (!state.boundConvId || !state.isConnected || !state.roche) return;
    try {
      // 获取当前用户 persona ID，用于区分用户消息和 char 消息
      if (!state.currentUserPersonaId) {
        const active = await state.roche.persona.getActiveUserPersona();
        state.currentUserPersonaId = active ? active.id : null;
      }

      const msgs = await state.roche.memory.getShortTerm({
        conversationId: state.boundConvId,
        limit: 10
      });
      if (!msgs || !msgs.length) return;

      // 按时间升序排列
      msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      // 从最新向最旧扫描，找到第一条未处理的 char 消息（含 <vi> 标签）
      // 若同一时间有多条新消息，则取最早一条未处理的，按顺序处理
      // 简化：找到所有 timestamp > lastProcessedTs 的 char 消息，按时间升序处理最后一条的序列
      // 实际：处理最近一条包含 <vi> 的新 char 消息
      let targetMsg = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        // 跳过用户自己的消息
        if (msg.senderId === state.currentUserPersonaId) continue;
        // 跳过非文本/系统/动作消息
        if (msg.type === 'system' || msg.type === 'action') continue;
        const ts = msg.timestamp || 0;
        if (ts <= state.lastProcessedTs) continue;
        // 检查是否包含 <vi> 标签
        const steps = parseViTags(msg.text || '');
        if (steps.length > 0) {
          targetMsg = msg;
          break;
        }
      }

      if (targetMsg) {
        const steps = parseViTags(targetMsg.text || '');
        const ts = targetMsg.timestamp || Date.now();
        // 更新时间戳先保存（避免重复处理）
        state.lastProcessedTs = ts;
        if (state.roche) {
          try { await state.roche.storage.set('toyLastTs', state.lastProcessedTs); } catch (e) {}
        }
        // 播放序列
        await playSequence(steps, '聊天指令');
      }
    } catch (e) {
      console.log('监控检查异常:', e);
    }
  }

  function startMonitor() {
    if (state.monitorInterval) clearInterval(state.monitorInterval);
    if (!state.boundConvId || !state.isConnected) return;
    state.isMonitoring = true;
    state.monitorInterval = trackInterval(checkMessages, POLL_FOREGROUND);
    if (state.roche) {
      try { state.roche.storage.set('toyAutoMonitor', true); } catch (e) {}
    }
    updateStatus(state.isConnected ? ('✅ 已连接: ' + DEVICE_NAME + ' | 监控中') : '未连接');
  }

  function stopMonitor() {
    if (state.monitorInterval) {
      clearInterval(state.monitorInterval);
      state.monitorInterval = null;
    }
    state.isMonitoring = false;
    if (state.roche) {
      try { state.roche.storage.set('toyAutoMonitor', false); } catch (e) {}
    }
  }

  // 后台运行：页面可见性变化时调整轮询频率
  function setupVisibilityHandler() {
    const handler = () => {
      if (!state.isMonitoring) return;
      if (state.monitorInterval) {
        clearInterval(state.monitorInterval);
        state.monitorInterval = null;
      }
      const ms = document.hidden ? POLL_BACKGROUND : POLL_FOREGROUND;
      state.monitorInterval = trackInterval(checkMessages, ms);
    };
    document.addEventListener('visibilitychange', handler);
    state.cleanup.visibilityHandler = { target: document, event: 'visibilitychange', handler };
  }

  // ============================================================
  // 插件 UI
  // ============================================================
  const pluginApp = {
    id: 'toy-controller-home',
    name: 'AI 玩具控制',
    icon: 'bluetooth',
    async mount(container, roche) {
      state.roche = roche;
      state.container = container;

      // 加载持久化设置
      if (roche.storage) {
        try {
          state.boundConvId = (await roche.storage.get('toyConversationId')) || '';
          state.autoMonitor = (await roche.storage.get('toyAutoMonitor')) || false;
          state.lastProcessedTs = (await roche.storage.get('toyLastTs')) || 0;
        } catch (e) {}
      }

      // 渲染 UI（深色主题）
      container.innerHTML = `
        <style>
          .roche-plugin-toy {
            --bg: #1a1a2e;
            --bg-soft: #20203a;
            --bg-card: #252542;
            --bg-input: #16162b;
            --text: #eee;
            --text-dim: #aaa;
            --text-mute: #777;
            --accent: #6c63ff;
            --accent-soft: #4a42c0;
            --green: #4caf50;
            --red: #f44336;
            --orange: #ff9800;
            --blue: #2196f3;
            --border: #3a3a55;
            padding: 14px;
            max-width: 500px;
            margin: 0 auto;
            font-size: 14px;
            color: var(--text);
            background: var(--bg);
            overflow-y: auto;
            max-height: 100vh;
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .roche-plugin-toy * { box-sizing: border-box; }
          .roche-plugin-toy h3 {
            margin: 0 0 4px 0;
            font-size: 18px;
            color: var(--text);
          }
          .roche-plugin-toy .subtitle {
            margin: 0 0 12px 0;
            font-size: 11px;
            color: var(--text-mute);
          }
          .roche-plugin-toy section {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px 12px;
            margin-bottom: 10px;
          }
          .roche-plugin-toy section h4 {
            margin: 0 0 8px 0;
            font-size: 13px;
            color: var(--accent);
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .roche-plugin-toy .row {
            display: flex;
            gap: 6px;
            align-items: center;
            margin-bottom: 6px;
          }
          .roche-plugin-toy .row:last-child { margin-bottom: 0; }
          .roche-plugin-toy select,
          .roche-plugin-toy input[type="text"],
          .roche-plugin-toy input[type="number"] {
            flex: 1;
            padding: 7px 9px;
            background: var(--bg-input);
            color: var(--text);
            border: 1px solid var(--border);
            border-radius: 6px;
            font-size: 13px;
            outline: none;
          }
          .roche-plugin-toy select:focus,
          .roche-plugin-toy input:focus {
            border-color: var(--accent);
          }
          .roche-plugin-toy input[type="range"] {
            flex: 1;
            accent-color: var(--accent);
            cursor: pointer;
          }
          .roche-plugin-toy button {
            border: none;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 13px;
            color: #fff;
            cursor: pointer;
            transition: opacity 0.15s, transform 0.05s;
            font-weight: 500;
          }
          .roche-plugin-toy button:hover { opacity: 0.88; }
          .roche-plugin-toy button:active { transform: scale(0.97); }
          .roche-plugin-toy button.green { background: var(--green); }
          .roche-plugin-toy button.red { background: var(--red); }
          .roche-plugin-toy button.blue { background: var(--blue); }
          .roche-plugin-toy button.orange { background: var(--orange); }
          .roche-plugin-toy button.gray { background: #555; }
          .roche-plugin-toy button.accent { background: var(--accent); }
          .roche-plugin-toy .btn-block { width: 100%; }
          .roche-plugin-toy .label {
            font-size: 12px;
            color: var(--text-dim);
            min-width: 38px;
          }
          .roche-plugin-toy .val {
            font-size: 12px;
            color: var(--accent);
            min-width: 28px;
            text-align: right;
            font-weight: 600;
          }
          .roche-plugin-toy .status-box {
            padding: 7px 10px;
            border-radius: 6px;
            background: var(--bg-input);
            font-size: 12px;
            min-height: 22px;
            color: var(--text-dim);
            border: 1px solid var(--border);
            word-break: break-all;
          }
          .roche-plugin-toy .status-box.ok { color: var(--green); border-color: var(--green); }
          .roche-plugin-toy .status-box.err { color: var(--red); border-color: var(--red); }
          .roche-plugin-toy .status-box.info { color: var(--blue); border-color: var(--blue); }
          .roche-plugin-toy .checkbox-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: var(--text);
            cursor: pointer;
            padding: 4px 0;
          }
          .roche-plugin-toy .checkbox-row input { accent-color: var(--accent); cursor: pointer; }
          .roche-plugin-toy .grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            margin-bottom: 6px;
          }
          .roche-plugin-toy .stat-box {
            background: var(--bg-input);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px;
            text-align: center;
          }
          .roche-plugin-toy .stat-box .lbl { font-size: 11px; color: var(--text-mute); }
          .roche-plugin-toy .stat-box .num { font-size: 22px; font-weight: 700; color: var(--accent); }
          .roche-plugin-toy .notify-box {
            font-family: "Consolas", "Monaco", monospace;
            font-size: 11px;
            background: var(--bg-input);
            padding: 7px 9px;
            border-radius: 6px;
            max-height: 110px;
            overflow-y: auto;
            word-break: break-all;
            color: var(--text-dim);
            border: 1px solid var(--border);
          }
          .roche-plugin-toy .help {
            background: var(--bg-soft);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px 12px;
            font-size: 11px;
            color: var(--text-dim);
            line-height: 1.6;
          }
          .roche-plugin-toy .help code {
            background: var(--bg-input);
            padding: 1px 5px;
            border-radius: 3px;
            color: var(--accent);
            font-family: "Consolas", monospace;
          }
          .roche-plugin-toy .help ul { margin: 4px 0 0 0; padding-left: 18px; }
          .roche-plugin-toy .help li { margin: 2px 0; }
        </style>
        <div class="roche-plugin-toy">
          <h3>🤖 AI 玩具控制 v6.0</h3>
          <p class="subtitle">ANKNI MX · 双电机独立控制 · &lt;vi&gt; 标签实时监控</p>

          <!-- 聊天绑定 -->
          <section>
            <h4>💬 聊天绑定</h4>
            <div class="row">
              <select id="toy-conv-select">
                <option value="">-- 选择会话 --</option>
              </select>
              <button class="gray" id="toy-refresh" title="刷新会话列表">🔄</button>
            </div>
            <label class="checkbox-row">
              <input type="checkbox" id="toy-auto-monitor" />
              <span>后台自动监控（前台1.5s / 后台3s 轮询）</span>
            </label>
          </section>

          <!-- 蓝牙连接 -->
          <section>
            <h4>📡 蓝牙连接</h4>
            <div class="row">
              <button class="green" id="toy-connect" style="flex:1;">连接 ANKNI MX</button>
              <button class="red" id="toy-disconnect" style="flex:1;">断开</button>
            </div>
            <div id="toy-status" class="status-box">未连接</div>
          </section>

          <!-- 手动控制 -->
          <section>
            <h4>🎮 手动控制</h4>
            <div class="row">
              <span class="label">吮吸</span>
              <input type="range" id="toy-suction-slider" min="0" max="9" value="0" />
              <span class="val" id="toy-suction-val">0</span>
            </div>
            <div class="row">
              <span class="label">震动</span>
              <input type="range" id="toy-vibration-slider" min="0" max="9" value="0" />
              <span class="val" id="toy-vibration-val">0</span>
            </div>
            <div class="row">
              <button class="accent" id="toy-manual-send" style="flex:1;">发送指令</button>
              <button class="red" id="toy-manual-stop" style="flex:1;">停止</button>
            </div>
            <div style="font-size:10px;color:var(--text-mute);margin-top:4px;">
              值范围 0-9：0=关，1-3=强度，4-9=预设模式
            </div>
          </section>

          <!-- 当前状态 -->
          <section>
            <h4>📊 当前状态</h4>
            <div class="grid-2">
              <div class="stat-box">
                <div class="lbl">吮吸</div>
                <div class="num" id="toy-cur-suction">0</div>
              </div>
              <div class="stat-box">
                <div class="lbl">震动</div>
                <div class="num" id="toy-cur-vibration">0</div>
              </div>
            </div>
            <div id="toy-seq-status" class="status-box info">序列：空闲</div>
            <div id="toy-last-cmd" class="status-box" style="margin-top:6px;">等待指令...</div>
          </section>

          <!-- 实时数据 -->
          <section>
            <h4>🔔 实时数据 (NOTIFY)</h4>
            <div id="toy-notify-status" style="font-size:11px;color:var(--text-mute);margin-bottom:4px;">等待连接...</div>
            <div id="toy-notify-data" class="notify-box">--</div>
            <div id="toy-parsed-data" style="font-size:11px;margin-top:4px;color:var(--text-dim);"></div>
          </section>

          <!-- 使用说明 -->
          <section>
            <h4>📖 使用说明</h4>
            <div class="help">
              char 在回复中用 <code>&lt;vi&gt;</code> 标签控制玩具（HTML 标签，前端自动隐藏）：
              <ul>
                <li><code>&lt;vi s="3" v="2"/&gt;</code> — 吮吸3、震动2</li>
                <li><code>&lt;vi s="3" v="2" d="5"/&gt;</code> — 吸3震2，持续5秒后执行下一个</li>
                <li><code>&lt;vi s="0" v="2"/&gt;</code> — 仅震动</li>
                <li><code>&lt;vi stop/&gt;</code> — 停止所有</li>
              </ul>
              一条消息中可放多个 <code>&lt;vi&gt;</code> 形成序列，按顺序播放。
              <br><br>
              <strong>手动控制</strong>会取消当前序列，并向绑定会话注入一条用户消息
              （如：<code>（调整了玩具设置：吮吸3 震动2）</code>），让 char 知道你做了什么。
            </div>
          </section>

          <button class="gray btn-block" id="toy-close">返回</button>
        </div>
      `;

      const $ = (s) => container.querySelector(s);

      // 元素引用
      const statusDiv = $('#toy-status');
      const lastCmdDiv = $('#toy-last-cmd');
      const seqStatusDiv = $('#toy-seq-status');
      const convSelect = $('#toy-conv-select');
      const autoMonitorChk = $('#toy-auto-monitor');
      const suctionSlider = $('#toy-suction-slider');
      const vibrationSlider = $('#toy-vibration-slider');
      const suctionVal = $('#toy-suction-val');
      const vibrationVal = $('#toy-vibration-val');
      const curSuction = $('#toy-cur-suction');
      const curVibration = $('#toy-cur-vibration');
      const notifyStatusDiv = $('#toy-notify-status');
      const notifyDataDiv = $('#toy-notify-data');
      const parsedDataDiv = $('#toy-parsed-data');

      // 设置初始勾选状态
      autoMonitorChk.checked = state.autoMonitor;

      // UI 回调
      state.onStatusChange = (text, isError) => {
        statusDiv.textContent = text;
        statusDiv.className = 'status-box ' + (isError ? 'err' : (text.includes('✅') ? 'ok' : ''));
      };
      state.onLastCmdChange = (text) => { lastCmdDiv.textContent = text; };
      state.onSequenceChange = (text) => { seqStatusDiv.textContent = '序列：' + text; };
      state.onValuesChange = (s, v) => {
        curSuction.textContent = s;
        curVibration.textContent = v;
      };
      state.onNotifyData = (parsed) => {
        const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        notifyDataDiv.textContent = `[${now}] ${parsed.raw || '--'}`;
        if (parsed.cmd !== undefined) {
          const payloadText = parsed.payload
            ? parsed.payload.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
            : '';
          parsedDataDiv.innerHTML =
            `<strong>解析:</strong> 帧头=0x${parsed.header.toString(16).toUpperCase()} ` +
            `命令=0x${parsed.cmd.toString(16).toUpperCase()} ` +
            `长度=${parsed.len} ` +
            `数据=[${payloadText}]`;
        } else if (parsed.checksumError) {
          parsedDataDiv.innerHTML = '<span style="color:var(--red);">⚠️ 校验和错误</span>';
        }
        notifyDataDiv.scrollTop = notifyDataDiv.scrollHeight;
      };

      // 通知状态显示
      function refreshNotifyStatus() {
        if (!state.isConnected) {
          notifyStatusDiv.textContent = '等待连接...';
          notifyStatusDiv.style.color = 'var(--text-mute)';
        } else if (state.notifyChar) {
          notifyStatusDiv.textContent = '🔔 已订阅通知，正在接收数据...';
          notifyStatusDiv.style.color = 'var(--green)';
        } else {
          notifyStatusDiv.textContent = '⚠️ 未找到 Notify 特征';
          notifyStatusDiv.style.color = 'var(--orange)';
        }
      }

      // 滑块值显示（用 trackListener 统一注册，便于清理）
      const onSuctionInput = () => { suctionVal.textContent = suctionSlider.value; };
      const onVibrationInput = () => { vibrationVal.textContent = vibrationSlider.value; };
      trackListener(suctionSlider, 'input', onSuctionInput);
      trackListener(vibrationSlider, 'input', onVibrationInput);

      // 加载会话列表
      async function populateConvs(selectId) {
        try {
          const convs = await roche.conversation.list();
          convSelect.innerHTML = '<option value="">-- 选择会话 --</option>';
          if (!convs || !convs.length) return;
          for (const c of convs) {
            const label = c.name || c.handle || c.id;
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = label + ' (' + (c.isGroup ? '群聊' : '单聊') + ')';
            convSelect.appendChild(opt);
            if (c.id === selectId) opt.selected = true;
          }
        } catch (e) {
          roche.ui.toast('加载会话列表失败: ' + e.message);
        }
      }
      populateConvs(state.boundConvId);

      // 刷新会话列表
      trackListener($('#toy-refresh'), 'click', () => populateConvs(state.boundConvId));

      // 选择会话
      convSelect.onchange = async () => {
        state.boundConvId = convSelect.value;
        try { await roche.storage.set('toyConversationId', state.boundConvId); } catch (e) {}
        if (state.boundConvId && state.autoMonitor && state.isConnected) {
          startMonitor();
          roche.ui.toast('已绑定会话，监控已启动');
        } else {
          roche.ui.toast(state.boundConvId ? '已绑定会话' : '已取消绑定');
        }
      };

      // 自动监控开关
      autoMonitorChk.onchange = async () => {
        state.autoMonitor = autoMonitorChk.checked;
        try { await roche.storage.set('toyAutoMonitor', state.autoMonitor); } catch (e) {}
        if (state.autoMonitor) {
          if (!state.boundConvId) {
            roche.ui.toast('请先选择会话');
            autoMonitorChk.checked = false;
            state.autoMonitor = false;
            try { await roche.storage.set('toyAutoMonitor', false); } catch (e) {}
            return;
          }
          if (!state.isConnected) {
            roche.ui.toast('请先连接蓝牙');
            autoMonitorChk.checked = false;
            state.autoMonitor = false;
            try { await roche.storage.set('toyAutoMonitor', false); } catch (e) {}
            return;
          }
          startMonitor();
          roche.ui.toast('后台监控已启动');
        } else {
          stopMonitor();
          roche.ui.toast('监控已停止');
        }
      };

      // 蓝牙连接
      trackListener($('#toy-connect'), 'click', async () => {
        const ok = await connectBluetooth();
        refreshNotifyStatus();
        if (ok && state.autoMonitor && state.boundConvId) startMonitor();
      });
      trackListener($('#toy-disconnect'), 'click', () => {
        disconnectBluetooth();
        refreshNotifyStatus();
      });

      // 手动发送
      $('#toy-manual-send').onclick = async () => {
        const s = parseInt(suctionSlider.value, 10) || 0;
        const v = parseInt(vibrationSlider.value, 10) || 0;
        // 1. 取消当前序列
        cancelSequence();
        // 2. 发送 BLE 指令
        const ok = await sendCmd(s, v);
        if (ok) {
          updateValues(s, v);
          updateLastCmd(`手动: 吸${s} 震${v}`);
          // 3. 向绑定会话注入用户消息
          if (state.boundConvId) {
            const text = `（调整了玩具设置：吮吸${s} 震动${v}）`;
            try {
              await injectUserMessage(state.boundConvId, text);
            } catch (e) {
              console.log('消息注入失败:', e);
            }
          }
        } else {
          updateLastCmd('发送失败，请检查蓝牙连接');
        }
      };

      // 手动停止
      $('#toy-manual-stop').onclick = async () => {
        cancelSequence();
        const ok = await sendStop();
        if (ok) {
          updateValues(0, 0);
          suctionSlider.value = 0;
          vibrationSlider.value = 0;
          suctionVal.textContent = '0';
          vibrationVal.textContent = '0';
          updateLastCmd('手动停止');
          if (state.boundConvId) {
            try {
              await injectUserMessage(state.boundConvId, '（停止了玩具）');
            } catch (e) {}
          }
        }
      };

      // 关闭
      trackListener($('#toy-close'), 'click', () => roche.ui.closeApp());

      // 设置可见性处理器
      setupVisibilityHandler();

      // 初始状态显示
      refreshNotifyStatus();
      updateValues(0, 0);
    },

    async unmount(container) {
      // 清理定时器
      stopMonitor();
      cancelSequence();

      // 清理所有事件监听
      for (const { target, event, handler } of state.cleanup.listeners) {
        try { target.removeEventListener(event, handler); } catch (e) {}
      }
      // 清理可见性监听
      if (state.cleanup.visibilityHandler) {
        try {
          state.cleanup.visibilityHandler.target.removeEventListener(
            state.cleanup.visibilityHandler.event,
            state.cleanup.visibilityHandler.handler
          );
        } catch (e) {}
      }
      // 清理所有 interval
      for (const id of state.cleanup.intervals) {
        clearInterval(id);
      }
      // 清理所有 timeout
      for (const id of state.cleanup.timeouts) {
        clearTimeout(id);
      }
      // 重置清理记录
      state.cleanup = { listeners: [], intervals: [], timeouts: [], visibilityHandler: null };

      // 清空回调
      state.onStatusChange = null;
      state.onLastCmdChange = null;
      state.onNotifyData = null;
      state.onSequenceChange = null;
      state.onValuesChange = null;

      // 清空容器
      try { container.replaceChildren(); } catch (e) { container.innerHTML = ''; }
      state.container = null;
    }
  };

  // ============================================================
  // 注册插件
  // ============================================================
  window.RochePlugin.register({
    id: 'ai-toy-controller',
    name: 'AI 玩具控制 (ANKNI MX)',
    version: '6.0.0',
    description: 'ANKNI MX 双电机独立控制 - 实时监控聊天 <vi> 指令自动控制玩具，支持序列播放与消息注入。',
    author: 'Roche 社区',
    apps: [pluginApp]
  });

  // 调试接口
  window.__toyController = {
    state,
    connect: connectBluetooth,
    disconnect: disconnectBluetooth,
    send: sendCmd,
    stop: sendStop,
    startMonitor,
    stopMonitor,
    parseViTags,
    playSequence,
    cancelSequence,
    injectUserMessage,
    buildCommand,
    buildStopCommand,
    parseNotify
  };
})();
