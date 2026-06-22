let currentConfig = null;
let currentDevices = [];
let currentMemos = [];
let currentStatus = null;
let currentLibrary = { recordings: [], cases: [], summary: {}, disk: null };
let selectedRecording = null;

const analysisMinutesByDevice = {};
const activeStreamAnalyses = new Set();

const elements = {
  analysisStatus: document.querySelector('#analysisStatus'),
  autoRecordToggle: document.querySelector('#autoRecordToggle'),
  exclusiveAudioToggle: document.querySelector('#exclusiveAudioToggle'),
  capturedMetric: document.querySelector('#capturedMetric'),
  caseCountLabel: document.querySelector('#caseCountLabel'),
  caseList: document.querySelector('#caseList'),
  casesMetric: document.querySelector('#casesMetric'),
  casesTabCount: document.querySelector('#casesTabCount'),
  chooseFolderButton: document.querySelector('#chooseFolderButton'),
  clipsMetricSub: document.querySelector('#clipsMetricSub'),
  deviceCount: document.querySelector('#deviceCount'),
  deviceList: document.querySelector('#deviceList'),
  discardSilenceToggle: document.querySelector('#discardSilenceToggle'),
  diskMetric: document.querySelector('#diskMetric'),
  diskMetricCard: document.querySelector('#diskMetricCard'),
  diskMetricSub: document.querySelector('#diskMetricSub'),
  historyMicFilter: document.querySelector('#historyMicFilter'),
  historySearch: document.querySelector('#historySearch'),
  historyTabCount: document.querySelector('#historyTabCount'),
  inputMetricSub: document.querySelector('#inputMetricSub'),
  loginToggle: document.querySelector('#loginToggle'),
  logOutput: document.querySelector('#logOutput'),
  memoCount: document.querySelector('#memoCount'),
  memoList: document.querySelector('#memoList'),
  micsTabCount: document.querySelector('#micsTabCount'),
  monitorGrid: document.querySelector('#monitorGrid'),
  openCasesButton: document.querySelector('#openCasesButton'),
  openFolderButton: document.querySelector('#openFolderButton'),
  otherDeviceList: document.querySelector('#otherDeviceList'),
  otherInputCount: document.querySelector('#otherInputCount'),
  otherInputsPanel: document.querySelector('#otherInputsPanel'),
  pidMetric: document.querySelector('#pidMetric'),
  playerButton: document.querySelector('#playerButton'),
  playerProgress: document.querySelector('#playerProgress'),
  playerSub: document.querySelector('#playerSub'),
  playerTime: document.querySelector('#playerTime'),
  playerTitle: document.querySelector('#playerTitle'),
  recordingList: document.querySelector('#recordingList'),
  recordingPill: document.querySelector('#recordingPill'),
  recordingsDir: document.querySelector('#recordingsDir'),
  refreshButton: document.querySelector('#refreshButton'),
  refreshLibraryButton: document.querySelector('#refreshLibraryButton'),
  saveButton: document.querySelector('#saveButton'),
  segmentMinutes: document.querySelector('#segmentMinutes'),
  sessionMetric: document.querySelector('#sessionMetric'),
  settingsStatus: document.querySelector('#settingsStatus'),
  silenceThreshold: document.querySelector('#silenceThreshold'),
  snapshotMetricSub: document.querySelector('#snapshotMetricSub'),
  startButton: document.querySelector('#startButton'),
  statusAlert: document.querySelector('#statusAlert'),
  stopButton: document.querySelector('#stopButton'),
  streamAnalysisStatus: document.querySelector('#streamAnalysisStatus'),
  targetMetric: document.querySelector('#targetMetric'),
  uptimeMetricSub: document.querySelector('#uptimeMetricSub')
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unitIndex = 0;

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    return 'Unknown';
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainingSeconds = Math.round(value % 60);

  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

function formatClock(isoTime) {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
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

function isRecordingCandidate(device) {
  const session = sessionForDevice(device.key);
  const profile = currentProfileDraft(device);

  return Boolean(session?.running || profile.enabled || device.captureEnabled);
}

function deviceBadge(device, session, enabled) {
  if (device.security && !device.security.allowed) {
    return '<span class="badge blocked">Blocked</span>';
  }

  if (session?.running) {
    return '<span class="badge recording"><span class="dot red"></span>Recording</span>';
  }

  if (enabled || device.captureEnabled) {
    return '<span class="badge selected">Selected</span>';
  }

  return '<span class="badge available">Available</span>';
}

function deviceSecurityLabel(device) {
  const security = device.security;
  if (!security) {
    return 'Security status unavailable';
  }

  return security.allowed
    ? `USB audio verified${security.transportLabel ? ` (${security.transportLabel})` : ''}`
    : security.detail;
}

function deviceSourceLabel(device) {
  return device.duplicateCount > 1
    ? `Input ${device.index} / ${device.occurrence} of ${device.duplicateCount}`
    : `Input ${device.index}`;
}

function pseudoLevelPercent(device, session) {
  if (!session?.running) {
    return 6;
  }

  const seed = [...String(device.key || device.name)].reduce((total, char) => total + char.charCodeAt(0), 0);
  return 34 + (seed % 31);
}

function renderDeviceCard(device, options = {}) {
  const session = sessionForDevice(device.key);
  const latest = session?.latestRecording;
  const battery = device.battery;
  const profile = currentProfileDraft(device);
  const analysisMinutes = analysisMinutesByDevice[device.key] || '30';
  const analysisActive = activeStreamAnalyses.has(device.key);
  const level = pseudoLevelPercent(device, session);
  const blocked = device.security && !device.security.allowed;
  const classes = [
    'device-item',
    !blocked && (profile.enabled || device.captureEnabled) ? 'target' : '',
    blocked ? 'blocked' : '',
    session?.running ? 'recording' : ''
  ].filter(Boolean).join(' ');
  const showAnalysis = options.showAnalysis !== false && !blocked;

  return `
    <li class="${classes}">
      <div class="device-head">
        <div>
          <span class="device-source">${escapeHtml(deviceSourceLabel(device))}</span>
          <div class="device-name">${escapeHtml(profile.targetName || device.displayName)}</div>
          <span class="device-raw">${escapeHtml(device.name)}</span>
        </div>
        ${deviceBadge(device, session, profile.enabled)}
      </div>

      <div class="vu-wrap">
        <div class="vu-row">
          <span class="vu-label">CAP</span>
          <div class="vu-meter">
            <div class="vu-fill" data-vu-fill="${escapeHtml(device.key)}" data-running="${session?.running ? '1' : '0'}" style="width:${level}%"></div>
            <div class="vu-peak" style="left:${Math.min(level + 8, 98)}%"></div>
          </div>
          <span class="clip-led">${session?.running ? 'stream active' : 'idle'}</span>
        </div>
        <div class="vu-scale"><span>idle</span><span>capture activity</span><span>hot</span></div>
      </div>

      <div class="mic-controls">
        <div class="ctrl">
          <label>Input gain</label>
          <div class="seg"><button type="button" disabled>Unavailable</button></div>
        </div>
        <div class="ctrl">
          <label>Monitor</label>
          <div class="seg"><button type="button" disabled>No live playback</button></div>
        </div>
        <div class="ctrl">
          <label>Format</label>
          <div class="seg"><button type="button" class="on" disabled>m4a</button><button type="button" disabled>wav</button><button type="button" disabled>flac</button></div>
        </div>
        <div class="ctrl">
          <label>Sample rate</label>
          <select disabled><option>Device default</option></select>
        </div>
      </div>

      <div class="facts">
        <span><span class="dot ${blocked ? 'red' : session?.running ? 'green' : profile.enabled ? 'amber' : 'red'}"></span>${blocked ? 'Blocked' : session?.running ? 'Recording' : profile.enabled ? 'Selected' : 'Not selected'}</span>
        <span class="${blocked ? 'bad' : 'ok'}">${escapeHtml(deviceSecurityLabel(device))}</span>
        <span class="${battery?.available ? 'ok' : ''}">${battery?.available ? `Battery ${battery.percent}%` : 'Battery unavailable'}</span>
        <span>Snapshot ${Math.round((currentStatus?.segmentSeconds || 1800) / 60)} min</span>
        <span>${latest ? `Latest: ${escapeHtml(latest.name)} (${formatBytes(latest.bytes)})` : 'No finalized file yet'}</span>
      </div>

      <div class="device-actions">
        <button type="button" class="${session?.running ? 'danger' : 'primary'} tiny" data-${session?.running ? 'stop' : 'start'}-device="${escapeHtml(device.key)}" ${blocked ? 'disabled' : ''}>${session?.running ? 'Stop' : 'Record'}</button>
        <button type="button" class="tiny" data-open-device="${escapeHtml(device.key)}">Folder</button>
        <label class="toggle ${blocked ? 'disabled' : ''}"><input type="checkbox" data-profile-enabled="${escapeHtml(device.key)}" ${!blocked && profile.enabled ? 'checked' : ''} ${blocked ? 'disabled' : ''}> Record this input</label>
      </div>

      <details class="device-details">
        <summary>Naming, storage and advanced</summary>
        <div class="kv">
          <span>Display name</span>
          <span><input type="text" data-profile-name="${escapeHtml(device.key)}" value="${escapeHtml(profile.targetName || device.displayName)}"></span>
          <span>Folder</span>
          <span><input type="text" data-profile-folder="${escapeHtml(device.key)}" value="${escapeHtml(profile.folderName || '')}"></span>
          <span>Source key</span>
          <span class="mono">${escapeHtml(device.key)}</span>
          <span>Capture index</span>
          <span class="mono">${escapeHtml(device.index)}</span>
        </div>
      </details>

      ${showAnalysis ? `<div class="analysis-controls">
        <div class="analysis-heading">
          <strong>Analyze this recording device</strong>
          <span>Uses finalized snapshots, or makes a live checkpoint.</span>
        </div>
        <div class="device-actions">
          <input type="number" min="1" max="1440" step="1" data-analysis-minutes="${escapeHtml(device.key)}" value="${escapeHtml(analysisMinutes)}" aria-label="Analysis minutes">
          <button type="button" class="tiny" data-analyze-latest="${escapeHtml(device.key)}" ${analysisActive ? 'disabled' : ''}>Latest snapshot</button>
          <button type="button" class="tiny" data-analyze-window="${escapeHtml(device.key)}" ${analysisActive ? 'disabled' : ''}>Last N min</button>
          <button type="button" class="tiny" data-checkpoint-analyze="${escapeHtml(device.key)}" ${analysisActive ? 'disabled' : ''}>Live checkpoint</button>
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
  elements.micsTabCount.textContent = `${recordingDevices.length}`;
  elements.otherInputsPanel.hidden = otherDevices.length === 0;

  elements.deviceList.innerHTML = recordingDevices.length
    ? recordingDevices.map((device) => renderDeviceCard(device)).join('')
    : `<li class="device-item empty">
        ${currentDevices.length ? 'No USB recording devices are allowed by the current policy.' : 'No audio inputs found.'}
      </li>`;

  elements.otherDeviceList.innerHTML = otherDevices
    .map((device) => renderDeviceCard(device, { showAnalysis: false }))
    .join('');

  renderHistoryFilterOptions();
}

function renderMemos() {
  elements.memoCount.textContent = `${currentMemos.length}`;
  elements.memoList.innerHTML = currentMemos.length
    ? currentMemos.map((memo, index) => `
      <li class="memo-item">
        <div>
          <strong>${escapeHtml(memo.label || memo.relativePath)}</strong>
          <div class="memo-meta">
            <span>${escapeHtml(memo.createdAt ? formatClock(memo.createdAt) : 'Unknown date')}</span>
            <span>${formatDuration(memo.duration)}</span>
            <span>${formatBytes(memo.bytes)}</span>
            <span>${escapeHtml(memo.relativePath)}</span>
          </div>
        </div>
        <button type="button" class="tiny" data-analyze-memo="${index}" ${memo.exists ? '' : 'disabled'}>Analyze</button>
      </li>
    `).join('')
    : '<li class="memo-item"><div><strong>No Voice Memos available</strong><div class="memo-meta">The recorder still works. Apple Voice Memos did not return readable files.</div></div></li>';
}

function renderHistoryFilterOptions() {
  const selected = elements.historyMicFilter.value;
  const folders = [...new Set((currentLibrary.recordings || []).map((recording) => recording.folder).filter(Boolean))];

  elements.historyMicFilter.innerHTML = '<option value="">All mics</option>' + folders
    .map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`)
    .join('');
  elements.historyMicFilter.value = folders.includes(selected) ? selected : '';
}

function waveBars(recording) {
  const seed = [...String(recording.name || recording.path)].reduce((total, char) => total + char.charCodeAt(0), 0);
  let html = '';

  for (let index = 0; index < 72; index += 1) {
    const height = 6 + Math.abs(Math.sin((index + seed) * 0.37) * Math.cos(index * 0.11)) * 20;
    html += `<i style="height:${Math.round(height)}px"></i>`;
  }

  return html;
}

function filteredRecordings() {
  const query = elements.historySearch.value.trim().toLowerCase();
  const folder = elements.historyMicFilter.value;

  return (currentLibrary.recordings || []).filter((recording) => {
    const haystack = `${recording.name} ${recording.relativePath} ${recording.folder}`.toLowerCase();
    return (!query || haystack.includes(query)) && (!folder || recording.folder === folder);
  });
}

function renderHistory() {
  const recordings = filteredRecordings();
  elements.historyTabCount.textContent = `${currentLibrary.summary?.recordingCount || 0}`;

  elements.recordingList.innerHTML = recordings.length
    ? recordings.map((recording, index) => `
      <div class="rec-row" data-select-recording="${index}">
        <div>
          <div class="rec-name">${escapeHtml(formatClock(recording.startedAt || recording.modifiedAt))}</div>
          <div class="rec-sub">${escapeHtml(recording.folder || 'recordings')}</div>
        </div>
        <div class="wave" title="Timeline preview, not a measured waveform">${waveBars(recording)}</div>
        <span>${formatBytes(recording.bytes)}</span>
        <span><span class="tag">${escapeHtml(recording.name.split('.').pop() || 'audio')}</span></span>
        <span class="device-actions">
          <button type="button" class="tiny" data-pick-recording="${index}">Select</button>
          <button type="button" class="tiny" data-analyze-recording="${index}">Analyze</button>
        </span>
      </div>
    `).join('')
    : '<div class="empty">No finalized snapshots found yet.</div>';

  if (!selectedRecording && recordings[0]) {
    selectedRecording = recordings[0];
  }
  renderPlayer();
}

function renderPlayer() {
  if (!selectedRecording) {
    elements.playerTitle.textContent = 'No recording selected';
    elements.playerSub.textContent = 'Select a snapshot from history';
    elements.playerTime.textContent = '0:00 / 0:00';
    elements.playerProgress.style.width = '0';
    return;
  }

  elements.playerTitle.textContent = selectedRecording.name;
  elements.playerSub.textContent = `${selectedRecording.folder || 'recordings'} - ${formatBytes(selectedRecording.bytes)}`;
  elements.playerTime.textContent = `${formatClock(selectedRecording.startedAt || selectedRecording.modifiedAt)}`;
  elements.playerProgress.style.width = '0';
}

function clipFeatureLabel(clip) {
  const labels = clip.audioFeatures?.labels || {};
  return [
    labels.loudness,
    labels.texture,
    labels.dynamics
  ].filter(Boolean).join(' / ') || 'features unavailable';
}

function renderCollectionPreview(collection) {
  const clipIndexes = (collection.clipIndexes || [])
    .map((index) => `clip-${String(index).padStart(3, '0')}`)
    .join(', ');

  return `
    <div class="collection-row">
      <div>
        <strong>${escapeHtml(collection.label || collection.collectionId)}</strong>
        <div class="rec-sub">${escapeHtml(collection.clipCount || 0)} clip(s) - ${formatDuration(collection.totalDurationSeconds || 0)} - ${escapeHtml(clipIndexes || 'no clips')}</div>
      </div>
      <span class="tag collection">${escapeHtml(collection.collectionId)}</span>
    </div>
  `;
}

function renderCases() {
  const cases = currentLibrary.cases || [];
  elements.caseCountLabel.textContent = `${cases.length}`;
  elements.casesTabCount.textContent = `${cases.length}`;
  elements.casesMetric.textContent = `${cases.length}`;
  elements.clipsMetricSub.textContent = `${currentLibrary.summary?.clipCount || 0} clips, ${currentLibrary.summary?.collectionCount || 0} collections`;

  elements.caseList.innerHTML = cases.length
    ? cases.map((item) => `
      <article class="case-card">
        <div class="case-head">
          <div>
            <strong>${escapeHtml(item.caseId)}</strong>
            <div class="case-id">${escapeHtml(item.sourceCount)} source(s) - ${escapeHtml(item.clipCount)} clip(s) - ${escapeHtml(item.collectionCount || 0)} collection(s)</div>
          </div>
          <span class="tag case">Manifest</span>
        </div>
        <div class="case-report">
          <strong>Report</strong>
          <span>${escapeHtml(item.report?.summary || 'No report summary available')}</span>
        </div>
        ${(item.similarityCollections || []).length ? `
          <div class="collection-list">
            <div class="collection-title">Similar sound collections</div>
            ${(item.similarityCollections || []).map(renderCollectionPreview).join('')}
          </div>
        ` : '<div class="collection-list"><div class="empty">No similarity collections in this case.</div></div>'}
        <div class="clip-list">
          ${(item.clips || []).length ? item.clips.map((clip) => `
            <div class="clip">
              <div>
                <strong>clip-${String(clip.index || clip.sourceClipIndex || 0).padStart(3, '0')}</strong>
                <span class="rec-sub">${escapeHtml(clip.startSeconds)}s to ${escapeHtml(clip.endSeconds)}s - ${escapeHtml(clip.collectionId || 'unassigned')}</span>
                <div class="feature-line">${escapeHtml(clipFeatureLabel(clip))}</div>
              </div>
              <span class="score ${clip.score >= 70 ? 'hi' : clip.score >= 40 ? 'mid' : ''}">${escapeHtml(clip.score ?? '-')}</span>
            </div>
          `).join('') : '<div class="empty">No clips in this case.</div>'}
        </div>
        <div class="device-actions" style="padding:11px 15px;border-top:1px solid var(--line-soft)">
          ${item.report?.markdownPath ? `<button type="button" class="tiny" data-open-report="${escapeHtml(item.report.markdownPath)}">Open report</button>` : ''}
          <button type="button" class="tiny" data-open-case="${escapeHtml(item.caseDir)}">Open case folder</button>
        </div>
      </article>
    `).join('')
    : '<div class="empty">No cases yet. Analyze a snapshot or Voice Memo to create one.</div>';
}

function renderMonitor() {
  const sessions = currentStatus?.sessions || [];
  const devices = currentDevices || [];

  elements.monitorGrid.innerHTML = devices.length
    ? devices.map((device) => {
      const session = sessionForDevice(device.key);
      const profile = currentProfileDraft(device);
      const blocked = device.security && !device.security.allowed;
      const state = blocked ? 'Blocked' : session?.running ? 'Recording' : profile.enabled ? 'Selected' : 'Available';
      const dot = session?.running ? 'green' : profile.enabled && !blocked ? 'amber' : 'red';

      return `
        <article class="monitor-card">
          <div class="device-head">
            <div>
              <span class="device-source">${escapeHtml(deviceSourceLabel(device))}</span>
              <div class="device-name">${escapeHtml(profile.targetName || device.displayName)}</div>
            </div>
            <span class="badge ${blocked ? 'blocked' : session?.running ? 'recording' : profile.enabled ? 'selected' : 'available'}">${escapeHtml(state)}</span>
          </div>
          <div class="facts">
            <span><span class="dot ${dot}"></span>${escapeHtml(state)}</span>
            <span class="${blocked ? 'bad' : 'ok'}">${escapeHtml(deviceSecurityLabel(device))}</span>
            <span>${session?.pid ? `pid ${session.pid}` : 'no process'}</span>
            <span>${session?.latestRecording ? `latest ${formatBytes(session.latestRecording.bytes)}` : 'no snapshot'}</span>
            <span>${session?.lastError ? `error: ${escapeHtml(session.lastError)}` : 'no recorder error'}</span>
          </div>
        </article>
      `;
    }).join('')
    : '<div class="empty">No devices detected.</div>';

  const auditLogLine = currentStatus?.auditLogPath ? `Audit log: ${currentStatus.auditLogPath}` : '';
  elements.logOutput.textContent = sessions.length
    ? [auditLogLine, ...sessions.flatMap((session) => [`[${session.displayName}]`, ...(session.recentLog || [])])].filter(Boolean).join('\n')
    : [currentStatus?.lastError || '', auditLogLine].filter(Boolean).join('\n');
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
  elements.exclusiveAudioToggle.checked = config.exclusiveAudioAccess !== false;
  elements.discardSilenceToggle.checked = config.preserveOriginalRecordings === false && config.discardSilenceSnapshots === true;
  elements.settingsStatus.textContent = `${Math.round((config.segmentSeconds || 1800) / 60)} min snapshots`;
}

function oldestSessionStartedAt(status) {
  const starts = (status?.sessions || [])
    .filter((session) => session.running && session.startedAt)
    .map((session) => new Date(session.startedAt).getTime())
    .filter(Number.isFinite);

  return starts.length ? new Date(Math.min(...starts)).toISOString() : null;
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
  const startedAt = oldestSessionStartedAt(status);

  elements.recordingPill.className = `pill ${isRunning ? 'recording' : hasError ? 'warning' : 'idle'}`;
  elements.recordingPill.innerHTML = isRunning ? `<span class="live-dot"></span>Recording - ${status.runningCount}` : hasError ? 'Needs attention' : 'Idle';
  elements.statusAlert.hidden = !hasError;
  elements.statusAlert.textContent = hasError ? status.lastError : '';
  elements.targetMetric.textContent = String(status?.targetCount || 0);
  elements.sessionMetric.textContent = String(status?.runningCount || 0);
  elements.inputMetricSub.textContent = `${currentDevices.length} input endpoint(s), ${status?.securitySummary?.blockedCount || 0} blocked`;
  elements.uptimeMetricSub.textContent = startedAt ? `since ${formatClock(startedAt)}` : 'idle';
  elements.snapshotMetricSub.textContent = `${currentLibrary.summary?.todayRecordingCount || 0} snapshots`;
  elements.pidMetric.textContent = isRunning ? `${status.runningCount} active` : 'No processes';
  elements.stopButton.disabled = !isRunning;
  elements.startButton.disabled = false;

  if (latest) {
    selectedRecording ||= latest;
  }

  renderDevices();
  renderMonitor();
  renderConfig();
}

function renderLibrary() {
  const summary = currentLibrary.summary || {};
  const disk = currentLibrary.disk;

  elements.capturedMetric.textContent = formatBytes(summary.todayBytes || 0);
  elements.snapshotMetricSub.textContent = `${summary.todayRecordingCount || 0} snapshots`;
  elements.diskMetric.textContent = disk ? formatBytes(disk.availableBytes) : 'Unknown';
  elements.diskMetricSub.textContent = disk?.mount || 'recordings volume';
  elements.diskMetricCard.classList.toggle('warn', Boolean(disk && disk.availableBytes < 25 * 1024 ** 3));

  renderHistoryFilterOptions();
  renderHistory();
  renderCases();
}

function addLoadError(errors, label, result) {
  if (result.status === 'rejected') {
    errors.push(`${label}: ${result.reason?.message || result.reason || 'failed'}`);
  }
}

async function refreshAll() {
  const previousRefreshLabel = elements.refreshButton.textContent;
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = 'Refreshing...';
  elements.streamAnalysisStatus.textContent = 'Refreshing devices and library';

  try {
    const [devicesResult] = await Promise.allSettled([
      window.soundbite.listDevices()
    ]);
    const [configResult, statusResult, loginResult, memosResult, libraryResult] = await Promise.allSettled([
      window.soundbite.getConfig(),
      window.soundbite.getStatus(),
      window.soundbite.getLogin(),
      window.soundbite.listVoiceMemos(),
      window.soundbite.listLibrary()
    ]);
    const loadErrors = [];

    if (configResult.status === 'fulfilled') currentConfig = configResult.value;
    if (devicesResult.status === 'fulfilled') currentDevices = devicesResult.value;
    if (loginResult.status === 'fulfilled') elements.loginToggle.checked = Boolean(loginResult.value.openAtLogin);
    if (memosResult.status === 'fulfilled') currentMemos = memosResult.value;
    if (libraryResult.status === 'fulfilled') currentLibrary = libraryResult.value;

    addLoadError(loadErrors, 'Config', configResult);
    addLoadError(loadErrors, 'Devices', devicesResult);
    addLoadError(loadErrors, 'Status', statusResult);
    addLoadError(loadErrors, 'Login', loginResult);
    addLoadError(loadErrors, 'Voice Memos', memosResult);
    addLoadError(loadErrors, 'Library', libraryResult);

    if (statusResult.status === 'fulfilled') {
      renderStatus(statusResult.value);
    }
    renderConfig();
    renderMemos();
    renderLibrary();

    elements.streamAnalysisStatus.textContent = loadErrors.length
      ? `Loaded with warnings: ${loadErrors.join('; ')}`
      : 'No stream analysis running';
  } catch (error) {
    elements.streamAnalysisStatus.textContent = error?.message || 'Refresh failed';
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = previousRefreshLabel;
  }
}

async function refreshLibrary() {
  const previousRefreshLabel = elements.refreshLibraryButton.textContent;
  elements.refreshLibraryButton.disabled = true;
  elements.refreshLibraryButton.textContent = 'Refreshing...';

  try {
    currentLibrary = await window.soundbite.listLibrary();
    renderLibrary();
  } catch (error) {
    elements.streamAnalysisStatus.textContent = error?.message || 'Library refresh failed';
  } finally {
    elements.refreshLibraryButton.disabled = false;
    elements.refreshLibraryButton.textContent = previousRefreshLabel;
  }
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
      enabled: device.security?.allowed !== false && Boolean(enabled?.checked),
      targetName: targetName?.value || device.displayName,
      folderName: folderName?.value || device.profile?.folderName
    };
  }

  currentConfig = await window.soundbite.updateConfig({
    segmentSeconds: Number.isFinite(segmentMinutes) ? segmentMinutes * 60 : baseConfig.segmentSeconds,
    silenceMaxVolumeDb: Number.isFinite(silenceMaxVolumeDb) ? silenceMaxVolumeDb : baseConfig.silenceMaxVolumeDb,
    discardSilenceSnapshots: elements.discardSilenceToggle.checked,
    preserveOriginalRecordings: !elements.discardSilenceToggle.checked,
    autoRecord: elements.autoRecordToggle.checked,
    exclusiveAudioAccess: elements.exclusiveAudioToggle.checked,
    micProfiles
  });
  await window.soundbite.setLogin(elements.loginToggle.checked);
  currentDevices = await window.soundbite.listDevices();
  renderConfig();
  renderStatus(await window.soundbite.getStatus());
  await refreshLibrary();
}

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
    await refreshLibrary();
  } catch (error) {
    elements.streamAnalysisStatus.textContent = error?.message || 'Stream analysis failed';
  } finally {
    activeStreamAnalyses.delete(deviceKey);
    renderDevices();
  }
}

function handleDeviceInput(event) {
  const deviceKey = event.target?.dataset?.analysisMinutes;
  if (deviceKey) {
    analysisMinutesByDevice[deviceKey] = event.target.value;
  }
}

async function handleDeviceClick(event) {
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
    await refreshAll();
    elements.streamAnalysisStatus.textContent = 'Recording stopped';
  } else if (openKey) {
    renderStatus(await window.soundbite.openDeviceFolder(openKey));
  } else if (analyzeLatestKey) {
    await runStreamAnalysis(analyzeLatestKey, 'Analyzing latest finalized snapshot', () => window.soundbite.analyzeStreamLatest(analyzeLatestKey));
  } else if (analyzeWindowKey) {
    const minutes = analysisMinutesForDevice(analyzeWindowKey);
    await runStreamAnalysis(analyzeWindowKey, `Analyzing finalized snapshots from the last ${minutes} minutes`, () => window.soundbite.analyzeStreamWindow(analyzeWindowKey, minutes));
  } else if (checkpointAnalyzeKey) {
    const minutes = analysisMinutesForDevice(checkpointAnalyzeKey);
    await runStreamAnalysis(checkpointAnalyzeKey, `Capturing and analyzing a ${minutes}-minute checkpoint`, () => window.soundbite.checkpointAnalyze(checkpointAnalyzeKey, minutes * 60));
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.view').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`#view-${tab.dataset.tab}`)?.classList.add('active');
  });
});

async function stopAllRecordings() {
  const previousStopLabel = elements.stopButton.textContent;
  elements.stopButton.disabled = true;
  elements.stopButton.textContent = 'Stopping...';
  elements.streamAnalysisStatus.textContent = 'Stopping recorder';

  try {
    renderStatus(await window.soundbite.stopAll());
    await refreshAll();
    elements.streamAnalysisStatus.textContent = 'Recording stopped';
  } catch (error) {
    elements.streamAnalysisStatus.textContent = error?.message || 'Stop failed';
    renderStatus(await window.soundbite.getStatus());
  } finally {
    elements.stopButton.textContent = previousStopLabel;
  }
}

elements.startButton.addEventListener('click', async () => renderStatus(await window.soundbite.startAll()));
elements.stopButton.addEventListener('click', stopAllRecordings);
elements.refreshButton.addEventListener('click', refreshAll);
elements.refreshLibraryButton.addEventListener('click', refreshLibrary);
elements.openFolderButton.addEventListener('click', async () => renderStatus(await window.soundbite.openFolder()));
elements.openCasesButton.addEventListener('click', async () => window.soundbite.openCasesFolder());
elements.chooseFolderButton.addEventListener('click', async () => {
  currentConfig = await window.soundbite.chooseFolder();
  renderConfig();
  await refreshLibrary();
});
elements.saveButton.addEventListener('click', saveSettings);
elements.historySearch.addEventListener('input', renderHistory);
elements.historyMicFilter.addEventListener('change', renderHistory);
elements.deviceList.addEventListener('input', handleDeviceInput);
elements.deviceList.addEventListener('click', handleDeviceClick);
elements.otherDeviceList.addEventListener('input', handleDeviceInput);
elements.otherDeviceList.addEventListener('click', handleDeviceClick);
elements.playerButton.addEventListener('click', () => {
  elements.playerSub.textContent = 'Playback is not wired yet. Use Finder to play the selected file.';
});

elements.recordingList.addEventListener('click', async (event) => {
  const pickIndex = event.target?.dataset?.pickRecording;
  const analyzeIndex = event.target?.dataset?.analyzeRecording;
  const recordings = filteredRecordings();

  if (pickIndex !== undefined) {
    selectedRecording = recordings[Number.parseInt(pickIndex, 10)] || null;
    renderPlayer();
  } else if (analyzeIndex !== undefined) {
    const recording = recordings[Number.parseInt(analyzeIndex, 10)];
    if (!recording) return;

    elements.streamAnalysisStatus.textContent = `Analyzing ${recording.name}`;
    try {
      const manifest = await window.soundbite.analyzeRecording(recording.path);
      elements.streamAnalysisStatus.textContent = `Created ${manifest.clips.length} clips in ${manifest.caseId}`;
      await refreshLibrary();
    } catch (error) {
      elements.streamAnalysisStatus.textContent = error?.message || 'Recording analysis failed';
    }
  }
});

elements.caseList.addEventListener('click', async (event) => {
  const caseDir = event.target?.dataset?.openCase;
  const reportPath = event.target?.dataset?.openReport;
  if (reportPath) {
    await window.soundbite.openCaseReport(reportPath);
  } else if (caseDir) {
    await window.soundbite.openCaseFolder(caseDir);
  }
});

elements.memoList.addEventListener('click', async (event) => {
  const memoIndex = event.target?.dataset?.analyzeMemo;
  if (memoIndex === undefined) return;

  const memo = currentMemos[Number.parseInt(memoIndex, 10)];
  if (!memo) return;

  elements.analysisStatus.textContent = `Analyzing ${memo.relativePath}`;
  event.target.disabled = true;

  try {
    const manifest = await window.soundbite.analyzeVoiceMemo(memo.path);
    elements.analysisStatus.textContent = `Created ${manifest.clips.length} clips in ${manifest.caseId}`;
    await refreshLibrary();
  } catch (error) {
    elements.analysisStatus.textContent = error?.message || 'Analysis failed';
  } finally {
    event.target.disabled = false;
  }
});

setInterval(() => {
  document.querySelectorAll('[data-vu-fill][data-running="1"]').forEach((fill) => {
    const current = Number.parseFloat(fill.style.width) || 40;
    const next = Math.max(28, Math.min(72, current + (Math.random() * 18 - 9)));
    fill.style.width = `${next}%`;
    const peak = fill.parentElement?.querySelector('.vu-peak');
    if (peak) peak.style.left = `${Math.min(next + 8, 98)}%`;
  });
}, 350);

window.soundbite.onStatus(renderStatus);
refreshAll();
