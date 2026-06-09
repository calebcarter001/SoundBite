let currentConfig = null;
let currentDevices = [];
let currentMemos = [];
let currentStatus = null;
const analysisMinutesByDevice = {};
const activeStreamAnalyses = new Set();

const elements = {
  analysisStatus: document.querySelector('#analysisStatus'),
  autoRecordToggle: document.querySelector('#autoRecordToggle'),
  chooseFolderButton: document.querySelector('#chooseFolderButton'),
  deviceCount: document.querySelector('#deviceCount'),
  deviceList: document.querySelector('#deviceList'),
  discardSilenceToggle: document.querySelector('#discardSilenceToggle'),
  latestMetric: document.querySelector('#latestMetric'),
  loginToggle: document.querySelector('#loginToggle'),
  logOutput: document.querySelector('#logOutput'),
  memoCount: document.querySelector('#memoCount'),
  memoList: document.querySelector('#memoList'),
  openCasesButton: document.querySelector('#openCasesButton'),
  openFolderButton: document.querySelector('#openFolderButton'),
  otherDeviceList: document.querySelector('#otherDeviceList'),
  otherInputCount: document.querySelector('#otherInputCount'),
  otherInputsPanel: document.querySelector('#otherInputsPanel'),
  pidMetric: document.querySelector('#pidMetric'),
  recordingsDir: document.querySelector('#recordingsDir'),
  recordingPill: document.querySelector('#recordingPill'),
  refreshButton: document.querySelector('#refreshButton'),
  saveButton: document.querySelector('#saveButton'),
  segmentMinutes: document.querySelector('#segmentMinutes'),
  settingsStatus: document.querySelector('#settingsStatus'),
  sessionMetric: document.querySelector('#sessionMetric'),
  silenceThreshold: document.querySelector('#silenceThreshold'),
  startButton: document.querySelector('#startButton'),
  streamAnalysisStatus: document.querySelector('#streamAnalysisStatus'),
  stopButton: document.querySelector('#stopButton'),
  targetMetric: document.querySelector('#targetMetric')
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    return 'Unknown duration';
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainingSeconds = Math.round(value % 60);

  if (hours) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }

  if (minutes) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function sessionForDevice(deviceKey) {
  return currentStatus?.sessions?.find((session) => session.key === deviceKey) || null;
}

function currentProfileDraft(device) {
  const enabledInput = document.querySelector(`[data-profile-enabled="${CSS.escape(device.key)}"]`);
  const targetNameInput = document.querySelector(`[data-profile-name="${CSS.escape(device.key)}"]`);
  const folderNameInput = document.querySelector(`[data-profile-folder="${CSS.escape(device.key)}"]`);
  const profile = device.profile || {};

  return {
    enabled: enabledInput ? enabledInput.checked : Boolean(profile.enabled),
    targetName: targetNameInput?.value || profile.targetName || device.displayName,
    folderName: folderNameInput?.value || profile.folderName || ''
  };
}

function deviceBadge(device, session, enabled) {
  if (session?.running) {
    return '<span class="device-badge recording">Recording</span>';
  }

  if (enabled || device.captureEnabled) {
    return '<span class="device-badge selected">Selected</span>';
  }

  return '<span class="device-badge available">Available</span>';
}

function isRecordingCandidate(device) {
  const session = sessionForDevice(device.key);
  const profile = currentProfileDraft(device);

  return Boolean(session?.running || profile.enabled || device.captureEnabled);
}

function renderDeviceCard(device, options = {}) {
      const session = sessionForDevice(device.key);
      const latest = session?.latestRecording;
      const battery = device.battery;
      const profile = currentProfileDraft(device);
      const analysisMinutes = analysisMinutesByDevice[device.key] || '30';
      const analysisActive = activeStreamAnalyses.has(device.key);
      const canAnalyze = options.showAnalysis !== false;
      const showStorage = options.showStorage !== false;
      const classes = [
        'device-item',
        profile.enabled || device.captureEnabled ? 'target' : '',
        session?.running ? 'recording' : ''
      ].filter(Boolean).join(' ');
      const sourceLabel = device.duplicateCount > 1
        ? `Input ${device.index} / ${device.occurrence} of ${device.duplicateCount}`
        : `Input ${device.index}`;

      return `
        <li class="${classes}">
          <div class="device-card-header">
            <div>
              <span class="device-source">${escapeHtml(sourceLabel)}</span>
              <strong>${escapeHtml(profile.targetName || device.displayName)}</strong>
              <span class="device-raw-name">${escapeHtml(device.name)}</span>
            </div>
            ${deviceBadge(device, session, profile.enabled)}
          </div>

          <div class="device-facts">
            <span class="${battery?.available ? 'available' : 'unavailable'}" title="${escapeHtml(battery?.detail || '')}">
              ${battery?.available ? `Battery ${battery.percent}%` : 'Battery unavailable'}
            </span>
            <span>Folder: ${escapeHtml(profile.folderName || device.profile?.folderName || 'not set')}</span>
            <span>${latest ? `Latest: ${escapeHtml(latest.name)} (${formatBytes(latest.bytes)})` : 'No finalized file yet'}</span>
          </div>

          <div class="device-actions primary-actions">
            <label class="mic-toggle">
              <input type="checkbox" data-profile-enabled="${escapeHtml(device.key)}" ${profile.enabled ? 'checked' : ''}>
              <span>Record this mic</span>
            </label>
            <button type="button" data-start-device="${escapeHtml(device.key)}" ${session?.running ? 'disabled' : ''}>Record</button>
            <button type="button" data-stop-device="${escapeHtml(device.key)}" ${session?.running ? '' : 'disabled'}>Stop</button>
            <button type="button" data-open-device="${escapeHtml(device.key)}">Folder</button>
          </div>

          ${showStorage ? `<details class="device-details">
            <summary>Names and storage</summary>
            <label class="profile-field">
              <span>Display name</span>
              <input type="text" data-profile-name="${escapeHtml(device.key)}" value="${escapeHtml(profile.targetName || device.displayName)}">
            </label>
            <label class="profile-field">
              <span>Folder name</span>
              <input type="text" data-profile-folder="${escapeHtml(device.key)}" value="${escapeHtml(profile.folderName || '')}">
            </label>
          </details>` : ''}

          ${canAnalyze ? `<div class="analysis-controls">
            <div class="analysis-heading">
              <strong>Analyze this mic</strong>
              <span>Uses finalized snapshots, or makes a live checkpoint.</span>
            </div>
            <label class="profile-field">
              <span>Analysis minutes</span>
              <input type="number" min="1" max="1440" step="1" data-analysis-minutes="${escapeHtml(device.key)}" value="${escapeHtml(analysisMinutes)}">
            </label>
            <div class="device-actions">
              <button type="button" data-analyze-latest="${escapeHtml(device.key)}" ${analysisActive ? 'disabled' : ''}>Latest snapshot</button>
              <button type="button" data-analyze-window="${escapeHtml(device.key)}" ${analysisActive ? 'disabled' : ''}>Last N min</button>
              <button type="button" data-checkpoint-analyze="${escapeHtml(device.key)}" ${analysisActive ? 'disabled' : ''}>Live checkpoint</button>
            </div>
          </div>` : ''}
        </li>
      `;
}

function renderDevices() {
  const recordingDevices = currentDevices.filter(isRecordingCandidate);
  const otherDevices = currentDevices.filter((device) => !isRecordingCandidate(device));

  elements.deviceCount.textContent = `${recordingDevices.length} selected`;
  elements.otherInputCount.textContent = `${otherDevices.length}`;
  elements.otherInputsPanel.hidden = otherDevices.length === 0;

  elements.deviceList.innerHTML = recordingDevices.length
    ? recordingDevices.map((device) => renderDeviceCard(device)).join('')
    : `<li class="device-item empty-state">
        <strong>${currentDevices.length ? 'No recording devices selected' : currentStatus?.running ? 'Recorder status is active, but devices did not load' : 'No audio inputs found'}</strong>
        <span>${currentDevices.length ? 'Choose a device from Other audio inputs, then save setup.' : currentStatus?.running ? 'Click Refresh Devices. If this persists, the device-list probe is failing while ffmpeg is recording.' : 'Connect a mic, then click Refresh Devices.'}</span>
      </li>`;

  elements.otherDeviceList.innerHTML = otherDevices
    .map((device) => renderDeviceCard(device, { showAnalysis: false, showStorage: true }))
    .join('');
}

function renderMemos() {
  elements.memoCount.textContent = `${currentMemos.length}`;
  elements.memoList.innerHTML = currentMemos.length
    ? currentMemos.map((memo, index) => `
      <li class="memo-item">
        <div>
          <strong>${escapeHtml(memo.label || memo.relativePath)}</strong>
          <div class="memo-meta">
            <span>${escapeHtml(memo.createdAt || 'Unknown date')}</span>
            <span>${formatDuration(memo.duration)}</span>
            <span>${formatBytes(memo.bytes)}</span>
            <span>${escapeHtml(memo.relativePath)}</span>
          </div>
        </div>
        <button type="button" data-analyze-memo="${index}" ${memo.exists ? '' : 'disabled'}>Analyze</button>
      </li>
    `).join('')
    : '<li class="memo-item"><div><strong>No Voice Memos available</strong><div class="memo-meta">The recorder still works. This only means Apple Voice Memos did not return readable files.</div></div></li>';
}

function renderConfig() {
  const config = currentConfig || currentStatus;
  if (!config) {
    return;
  }

  if (Number.isFinite(config.segmentSeconds)) {
    elements.segmentMinutes.value = String(Math.round(config.segmentSeconds / 60));
  }

  if (Number.isFinite(config.silenceMaxVolumeDb)) {
    elements.silenceThreshold.value = String(config.silenceMaxVolumeDb);
  }

  elements.recordingsDir.value = config.recordingsDir || '';
  elements.autoRecordToggle.checked = config.autoRecord !== false;
  elements.discardSilenceToggle.checked = config.discardSilenceSnapshots !== false;
  elements.settingsStatus.textContent = `${Math.round((config.segmentSeconds || 1800) / 60)} min snapshots`;
  renderDevices();
}

function renderStatus(status) {
  currentStatus = status;
  if (Array.isArray(status?.devices)) {
    currentDevices = status.devices;
  }

  const isRunning = Boolean(status?.running);
  const hasError = Boolean(status?.lastError);
  const latest = status?.sessions
    ?.map((session) => session.latestRecording)
    .filter(Boolean)
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())[0];

  elements.recordingPill.className = `pill ${isRunning ? 'recording' : hasError ? 'warning' : 'idle'}`;
  elements.recordingPill.textContent = isRunning ? 'Recording' : hasError ? 'Needs attention' : 'Idle';
  elements.targetMetric.textContent = String(status?.targetCount || 0);
  elements.sessionMetric.textContent = String(status?.runningCount || 0);
  elements.latestMetric.textContent = latest ? `${latest.name} (${formatBytes(latest.bytes)})` : 'None';
  elements.pidMetric.textContent = isRunning ? `${status.runningCount} active` : 'No processes';
  elements.logOutput.textContent = status?.sessions?.length
    ? status.sessions.flatMap((session) => {
      const heading = `[${session.displayName}]`;
      return [heading, ...(session.recentLog || [])];
    }).join('\n')
    : (status?.lastError || '');
  elements.startButton.disabled = false;
  elements.stopButton.disabled = !isRunning;
  renderDevices();
}

function addLoadError(errors, label, result) {
  if (result.status === 'rejected') {
    errors.push(`${label}: ${result.reason?.message || result.reason || 'failed'}`);
  }
}

async function refreshAll() {
  const [configResult, devicesResult, statusResult, loginResult, memosResult] = await Promise.allSettled([
    window.soundbite.getConfig(),
    window.soundbite.listDevices(),
    window.soundbite.getStatus(),
    window.soundbite.getLogin(),
    window.soundbite.listVoiceMemos()
  ]);
  const loadErrors = [];

  if (configResult.status === 'fulfilled') {
    currentConfig = configResult.value;
  }

  if (devicesResult.status === 'fulfilled') {
    currentDevices = devicesResult.value;
  }

  if (statusResult.status === 'fulfilled') {
    renderStatus(statusResult.value);
  }

  if (loginResult.status === 'fulfilled') {
    elements.loginToggle.checked = Boolean(loginResult.value.openAtLogin);
  }

  if (memosResult.status === 'fulfilled') {
    currentMemos = memosResult.value;
  } else {
    currentMemos = [];
  }

  addLoadError(loadErrors, 'Config', configResult);
  addLoadError(loadErrors, 'Devices', devicesResult);
  addLoadError(loadErrors, 'Status', statusResult);
  addLoadError(loadErrors, 'Login', loginResult);
  addLoadError(loadErrors, 'Voice Memos', memosResult);

  renderConfig();
  renderMemos();

  elements.streamAnalysisStatus.textContent = loadErrors.length
    ? `Loaded with warnings: ${loadErrors.join('; ')}`
    : 'No stream analysis running';
}

async function saveSettings() {
  const segmentMinutes = Number.parseInt(elements.segmentMinutes.value, 10);
  const silenceMaxVolumeDb = Number.parseFloat(elements.silenceThreshold.value);
  const baseConfig = currentConfig || currentStatus || {};
  const micProfiles = { ...(baseConfig.micProfiles || {}) };

  for (const device of currentDevices) {
    const enabled = document.querySelector(`[data-profile-enabled="${CSS.escape(device.key)}"]`);
    const targetName = document.querySelector(`[data-profile-name="${CSS.escape(device.key)}"]`);
    const folderName = document.querySelector(`[data-profile-folder="${CSS.escape(device.key)}"]`);

    micProfiles[device.key] = {
      ...(micProfiles[device.key] || {}),
      key: device.key,
      enabled: Boolean(enabled?.checked),
      targetName: targetName?.value || device.displayName,
      folderName: folderName?.value || device.profile?.folderName
    };
  }

  currentConfig = await window.soundbite.updateConfig({
    segmentSeconds: Number.isFinite(segmentMinutes) ? segmentMinutes * 60 : baseConfig.segmentSeconds,
    silenceMaxVolumeDb: Number.isFinite(silenceMaxVolumeDb) ? silenceMaxVolumeDb : baseConfig.silenceMaxVolumeDb,
    discardSilenceSnapshots: elements.discardSilenceToggle.checked,
    autoRecord: elements.autoRecordToggle.checked,
    micProfiles
  });
  await window.soundbite.setLogin(elements.loginToggle.checked);
  currentDevices = await window.soundbite.listDevices();
  renderConfig();
  renderStatus(await window.soundbite.getStatus());
}

elements.startButton.addEventListener('click', async () => {
  renderStatus(await window.soundbite.startAll());
});

elements.stopButton.addEventListener('click', async () => {
  renderStatus(await window.soundbite.stopAll());
});

elements.refreshButton.addEventListener('click', refreshAll);

elements.openFolderButton.addEventListener('click', async () => {
  renderStatus(await window.soundbite.openFolder());
});

elements.openCasesButton.addEventListener('click', async () => {
  await window.soundbite.openCasesFolder();
});

elements.chooseFolderButton.addEventListener('click', async () => {
  currentConfig = await window.soundbite.chooseFolder();
  renderConfig();
});

elements.saveButton.addEventListener('click', saveSettings);

function analysisMinutesForDevice(deviceKey) {
  const input = document.querySelector(`[data-analysis-minutes="${CSS.escape(deviceKey)}"]`);
  const value = Number.parseInt(input?.value || analysisMinutesByDevice[deviceKey] || '30', 10);

  return Number.isFinite(value) ? Math.min(Math.max(value, 1), 1440) : 30;
}

async function runStreamAnalysis(deviceKey, statusText, runner) {
  activeStreamAnalyses.add(deviceKey);
  elements.streamAnalysisStatus.textContent = statusText;
  renderDevices();

  try {
    const manifest = await runner();
    elements.streamAnalysisStatus.textContent = `Created ${manifest.clips.length} clips in ${manifest.caseId}`;
  } catch (error) {
    elements.streamAnalysisStatus.textContent = error?.message || 'Stream analysis failed';
  } finally {
    activeStreamAnalyses.delete(deviceKey);
    renderDevices();
  }
}

elements.deviceList.addEventListener('input', (event) => {
  const deviceKey = event.target?.dataset?.analysisMinutes;

  if (deviceKey) {
    analysisMinutesByDevice[deviceKey] = event.target.value;
  }
});

elements.deviceList.addEventListener('click', async (event) => {
  const startKey = event.target?.dataset?.startDevice;
  const stopKey = event.target?.dataset?.stopDevice;
  const openKey = event.target?.dataset?.openDevice;
  const analyzeLatestKey = event.target?.dataset?.analyzeLatest;
  const analyzeWindowKey = event.target?.dataset?.analyzeWindow;
  const checkpointAnalyzeKey = event.target?.dataset?.checkpointAnalyze;

  if (startKey) {
    renderStatus(await window.soundbite.startDevice(startKey));
  } else if (stopKey) {
    renderStatus(await window.soundbite.stopDevice(stopKey));
  } else if (openKey) {
    renderStatus(await window.soundbite.openDeviceFolder(openKey));
  } else if (analyzeLatestKey) {
    await runStreamAnalysis(
      analyzeLatestKey,
      'Analyzing latest finalized snapshot',
      () => window.soundbite.analyzeStreamLatest(analyzeLatestKey)
    );
  } else if (analyzeWindowKey) {
    const minutes = analysisMinutesForDevice(analyzeWindowKey);
    await runStreamAnalysis(
      analyzeWindowKey,
      `Analyzing finalized snapshots from the last ${minutes} minutes`,
      () => window.soundbite.analyzeStreamWindow(analyzeWindowKey, minutes)
    );
  } else if (checkpointAnalyzeKey) {
    const minutes = analysisMinutesForDevice(checkpointAnalyzeKey);
    await runStreamAnalysis(
      checkpointAnalyzeKey,
      `Capturing and analyzing a ${minutes}-minute checkpoint`,
      () => window.soundbite.checkpointAnalyze(checkpointAnalyzeKey, minutes * 60)
    );
  }
});

elements.memoList.addEventListener('click', async (event) => {
  const memoIndex = event.target?.dataset?.analyzeMemo;

  if (memoIndex === undefined) {
    return;
  }

  const memo = currentMemos[Number.parseInt(memoIndex, 10)];
  if (!memo) {
    return;
  }

  elements.analysisStatus.textContent = `Analyzing ${memo.relativePath}`;
  event.target.disabled = true;

  try {
    const manifest = await window.soundbite.analyzeVoiceMemo(memo.path);
    elements.analysisStatus.textContent = `Created ${manifest.clips.length} clips in ${manifest.caseId}`;
  } catch (error) {
    elements.analysisStatus.textContent = error?.message || 'Analysis failed';
  } finally {
    event.target.disabled = false;
  }
});

window.soundbite.onStatus(renderStatus);
refreshAll();
