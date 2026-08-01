'use strict';

/* ---------- 設定・状態 ---------- */
const $ = (s) => document.querySelector(s);
const DEFAULT_REPO = 'RyuRyu64/To-Do-Manager';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const CHAT_MODEL = 'llama-3.3-70b-versatile';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

const settings = {
  get groqKey() { return localStorage.getItem('vc_groq') || ''; },
  get pat() { return localStorage.getItem('vc_pat') || ''; },
  get repo() { return localStorage.getItem('vc_repo') || DEFAULT_REPO; },
  save(groq, pat, repo) {
    localStorage.setItem('vc_groq', groq.trim());
    localStorage.setItem('vc_pat', pat.trim());
    localStorage.setItem('vc_repo', (repo.trim() || DEFAULT_REPO).replace(/^https:\/\/github\.com\//, ''));
  },
  get ready() { return !!(this.groqKey && this.pat); },
};

let draft = null; // {transcript, type, title, slug, what, where, when, urgency, tags, body}

/* ---------- 日時 ---------- */
function nowParts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/* ---------- 画面切替 ---------- */
function showView(id) {
  ['view-home', 'view-settings'].forEach((v) => $('#' + v).classList.toggle('hidden', v !== id));
}
function showStage(id) {
  ['stage-record', 'stage-text', 'stage-processing', 'stage-preview', 'stage-done']
    .forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
  hideError();
}
function openSheet() {
  $('#sheet-backdrop').classList.remove('hidden');
  $('#sheet').classList.remove('hidden');
  requestAnimationFrame(() => {
    $('#sheet-backdrop').classList.add('show');
    $('#sheet').classList.add('show');
  });
  showStage('stage-record');
  $('#rec-status').textContent = 'タップして録音開始';
}
function closeSheet() {
  stopRecording(true);
  $('#sheet-backdrop').classList.remove('show');
  $('#sheet').classList.remove('show');
  setTimeout(() => {
    $('#sheet-backdrop').classList.add('hidden');
    $('#sheet').classList.add('hidden');
  }, 300);
}
function showError(msg) {
  $('#sheet-error-msg').textContent = msg;
  $('#sheet-error').classList.remove('hidden');
}
function hideError() { $('#sheet-error').classList.add('hidden'); }

/* ---------- 録音 ---------- */
let mediaStream = null, recorder = null, chunks = [], recMime = '';
let audioCtx = null, analyser = null, rafId = 0;

function pickMime() {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showError('マイクを使用できません。ブラウザの設定でマイクを許可してください。');
    return;
  }
  recMime = pickMime();
  chunks = [];
  recorder = new MediaRecorder(mediaStream, recMime ? { mimeType: recMime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = onRecordingStopped;
  recorder.start();
  startMeter();
  $('#btn-rec').classList.add('recording');
  $('#rec-status').textContent = '録音中… タップで終了';
}

function stopRecording(cancel = false) {
  cancelAnimationFrame(rafId);
  if (recorder && recorder.state !== 'inactive') {
    if (cancel) recorder.onstop = null;
    recorder.stop();
  }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  $('#btn-rec').classList.remove('recording');
  resetMeter();
}

function startMeter() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  audioCtx.createMediaStreamSource(mediaStream).connect(analyser);
  const bars = document.querySelectorAll('#level-meter span');
  const data = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    analyser.getByteFrequencyData(data);
    bars.forEach((bar, i) => {
      const v = data[Math.floor(i * data.length / bars.length)] / 255;
      bar.style.height = `${6 + v * 32}px`;
      bar.style.opacity = 0.35 + v * 0.65;
    });
    rafId = requestAnimationFrame(draw);
  };
  draw();
}
function resetMeter() {
  document.querySelectorAll('#level-meter span').forEach((b) => {
    b.style.height = '6px'; b.style.opacity = 0.35;
  });
}

async function onRecordingStopped() {
  const blob = new Blob(chunks, { type: recMime || 'audio/webm' });
  if (blob.size < 1000) { showStage('stage-record'); showError('録音が短すぎるか、音声が取得できませんでした。'); return; }
  showStage('stage-processing');
  $('#processing-label').textContent = '文字起こし中…';
  try {
    const transcript = await transcribe(blob);
    if (!transcript.trim()) throw new Error('音声からテキストを取得できませんでした');
    await structureAndPreview(transcript);
  } catch (e) {
    showStage('stage-record');
    showError(e.message);
  }
}

/* ---------- Groq API ---------- */
async function transcribe(blob) {
  const fd = new FormData();
  const ext = (recMime || '').includes('mp4') ? 'm4a' : 'webm';
  fd.append('file', blob, 'capture.' + ext);
  fd.append('model', WHISPER_MODEL);
  fd.append('language', 'ja');
  fd.append('response_format', 'json');
  const r = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + settings.groqKey },
    body: fd,
  });
  if (!r.ok) throw new Error(`文字起こしに失敗しました (${r.status})。Groqキーを確認してください。`);
  return (await r.json()).text || '';
}

const CLASSIFIER_PROMPT = `あなたは日本語音声メモの分類器。ユーザーのメモを次のJSONだけで返す:
{"type":"idea|todo|note","title":"短い日本語タイトル","slug":"english-kebab-case-slug","what":"何をするか/何の話か","where":"場所やサービス名(不明なら空文字)","when":"時期や期限(不明なら空文字)","urgency":"高|中|低|不明","tags":["英語小文字のタグを1〜4個"],"body":"メモをフィラーを除いて整理した本文"}
判定基準: 具体的な行動・買い物・連絡・期限があれば todo。作りたいもの・構想・思いつきは idea。事実や感想の記録は note。迷ったら note。
slugは内容を表す英単語2〜4語をハイフンで繋ぐ。JSONの外に文字を出力しない。`;

async function structureText(transcript) {
  const r = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + settings.groqKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: transcript },
      ],
    }),
  });
  if (!r.ok) throw new Error(`構造化に失敗しました (${r.status})。Groqキーを確認してください。`);
  const data = await r.json();
  let obj;
  try { obj = JSON.parse(data.choices[0].message.content); }
  catch { throw new Error('構造化結果の解析に失敗しました。もう一度お試しください。'); }
  return {
    type: ['idea', 'todo', 'note'].includes(obj.type) ? obj.type : 'note',
    title: obj.title || transcript.slice(0, 20),
    slug: (obj.slug || 'voice-capture').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'voice-capture',
    what: obj.what || '',
    where: obj.where || '',
    when: obj.when || '',
    urgency: ['高', '中', '低'].includes(obj.urgency) ? obj.urgency : '不明',
    tags: Array.isArray(obj.tags) ? obj.tags.slice(0, 4) : [],
    body: obj.body || transcript,
  };
}

async function structureAndPreview(transcript) {
  showStage('stage-processing');
  $('#processing-label').textContent = '構造化中…';
  const s = await structureText(transcript);
  draft = { transcript, ...s };
  renderPreview();
  showStage('stage-preview');
}

function renderPreview() {
  document.querySelectorAll('#seg-type button').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === draft.type));
  $('#pv-title').value = draft.title;
  $('#pv-what').value = draft.what;
  $('#pv-where').value = draft.where;
  $('#pv-when').value = draft.when;
  $('#pv-urgency').value = draft.urgency;
  $('#pv-tags').value = draft.tags.join(', ');
  $('#pv-body').value = draft.body;
  $('#pv-transcript').textContent = draft.transcript;
}

function collectPreview() {
  draft.title = $('#pv-title').value.trim() || draft.title;
  draft.what = $('#pv-what').value.trim();
  draft.where = $('#pv-where').value.trim();
  draft.when = $('#pv-when').value.trim();
  draft.urgency = $('#pv-urgency').value;
  draft.tags = $('#pv-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
  draft.body = $('#pv-body').value.trim();
}

/* ---------- GitHub API ---------- */
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${settings.repo}${path}`, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + settings.pat,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  return r;
}

async function putFile(path, content, message, sha) {
  const body = { message, content: b64encodeUtf8(content) };
  if (sha) body.sha = sha;
  return gh(`/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

async function getFile(path) {
  const r = await gh(`/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`);
  if (!r.ok) throw new Error(`${path} の取得に失敗しました (${r.status})。PATと権限を確認してください。`);
  const data = await r.json();
  return { text: b64decodeUtf8(data.content), sha: data.sha };
}

function buildIdeaFile() {
  const { date } = nowParts();
  const tags = draft.tags.length ? draft.tags : ['voice-capture'];
  const detail = [
    draft.what && `- 何を: ${draft.what}`,
    draft.where && `- どこで: ${draft.where}`,
    draft.when && `- いつ: ${draft.when}`,
    `- 緊急度: ${draft.urgency}`,
  ].filter(Boolean).join('\n');
  return `---
title: ${draft.title}
type: idea
status: inbox
created: ${date}
updated: ${date}
tags: [${tags.join(', ')}]
origin: 音声キャプチャPWA
---

# ${draft.title}

## 概要

${draft.body}

## 内容

${detail}

### 元の音声メモ（文字起こし）

> ${draft.transcript.replace(/\n/g, '\n> ')}

## ソース

- なし（自分の発案・音声メモ）

## 関連

- （あとで整理）

## 次のアクション

- [ ] このアイデアを整理・具体化する

## 更新履歴

- ${date}: 音声キャプチャPWAから登録
`;
}

function buildInboxLine() {
  const { date, time } = nowParts();
  const parts = [];
  if (draft.where) parts.push(`どこで: ${draft.where}`);
  if (draft.when) parts.push(`いつ: ${draft.when}`);
  parts.push(`緊急度: ${draft.urgency}`);
  const meta = parts.join(' ／ ');
  if (draft.type === 'todo') {
    return `- [ ] ${date} ${time}【todo】${draft.what || draft.title}（${meta}）`;
  }
  return `- ${date} ${time}【note】${draft.title} — ${draft.body.replace(/\n/g, ' ')}`;
}

async function saveDraft() {
  collectPreview();
  showStage('stage-processing');
  $('#processing-label').textContent = '保存中…';
  const { date } = nowParts();
  let savedPath = '';

  if (draft.type === 'idea') {
    const message = `Add idea from voice capture: ${draft.title}`;
    let slug = draft.slug, r = null;
    for (let i = 0; i < 4; i++) {
      const path = `ideas/${date}_${slug}.md`;
      r = await putFile(path, buildIdeaFile(), message);
      if (r.status === 201) { savedPath = path; break; }
      if (r.status === 422) { slug = `${draft.slug}-${i + 2}`; continue; } // 既存ファイルと衝突
      throw new Error(`保存に失敗しました (${r.status})。PATと権限を確認してください。`);
    }
    if (!savedPath) throw new Error('ファイル名の衝突が解消できませんでした。');
  } else {
    const inbox = await getFile('INBOX.md');
    const line = buildInboxLine();
    const marker = '### 振り分け済み';
    let text;
    if (inbox.text.includes(marker)) {
      text = inbox.text.replace(marker, line + '\n\n' + marker);
    } else {
      text = inbox.text.trimEnd() + '\n' + line + '\n';
    }
    const r = await putFile('INBOX.md', text, `Add ${draft.type} from voice capture: ${draft.title}`, inbox.sha);
    if (!r.ok) throw new Error(`INBOXへの保存に失敗しました (${r.status})。`);
    savedPath = 'INBOX.md';
  }

  addHistory({ type: draft.type, title: draft.title, path: savedPath, ...nowParts() });
  $('#done-detail').textContent = `${settings.repo} の ${savedPath} にコミットしました`;
  showStage('stage-done');
}

/* ---------- 履歴 ---------- */
function getHistory() {
  try { return JSON.parse(localStorage.getItem('vc_history') || '[]'); } catch { return []; }
}
function addHistory(entry) {
  const h = getHistory();
  h.unshift(entry);
  localStorage.setItem('vc_history', JSON.stringify(h.slice(0, 30)));
  renderHistory();
}
const TYPE_LABEL = { idea: 'アイデア', todo: 'TODO', note: 'メモ' };
function renderHistory() {
  const h = getHistory();
  const ul = $('#history-list');
  ul.innerHTML = '';
  $('#history-empty').classList.toggle('hidden', h.length > 0);
  h.forEach((e) => {
    const li = document.createElement('li');
    const type = document.createElement('span');
    type.className = 'h-type';
    type.textContent = TYPE_LABEL[e.type] || e.type;
    const main = document.createElement('div');
    main.className = 'h-main';
    const title = document.createElement('div');
    title.className = 'h-title';
    title.textContent = e.title;
    const time = document.createElement('div');
    time.className = 'h-time';
    time.textContent = `${e.date} ${e.time} → ${e.path}`;
    main.append(title, time);
    li.append(type, main);
    ul.appendChild(li);
  });
}

/* ---------- イベント ---------- */
function init() {
  renderHistory();
  $('#setup-banner').classList.toggle('hidden', settings.ready);

  $('#btn-settings').onclick = () => { loadSettingsForm(); showView('view-settings'); };
  $('#btn-goto-settings').onclick = () => { loadSettingsForm(); showView('view-settings'); };
  $('#btn-settings-back').onclick = () => showView('view-home');
  $('#btn-save-settings').onclick = () => {
    settings.save($('#input-groq').value, $('#input-pat').value, $('#input-repo').value);
    $('#settings-saved').classList.remove('hidden');
    $('#setup-banner').classList.toggle('hidden', settings.ready);
    setTimeout(() => $('#settings-saved').classList.add('hidden'), 2000);
  };

  $('#btn-capture').onclick = () => {
    if (!settings.ready) { loadSettingsForm(); showView('view-settings'); return; }
    openSheet();
  };
  $('#sheet-backdrop').onclick = closeSheet;

  $('#btn-rec').onclick = () => {
    if (recorder && recorder.state === 'recording') stopRecording();
    else startRecording();
  };
  $('#btn-text-mode').onclick = () => { stopRecording(true); showStage('stage-text'); };
  $('#btn-voice-mode').onclick = () => showStage('stage-record');
  $('#btn-text-submit').onclick = async () => {
    const text = $('#text-input').value.trim();
    if (!text) return;
    try { await structureAndPreview(text); $('#text-input').value = ''; }
    catch (e) { showStage('stage-text'); showError(e.message); }
  };

  document.querySelectorAll('#seg-type button').forEach((b) => {
    b.onclick = () => {
      draft.type = b.dataset.type;
      document.querySelectorAll('#seg-type button').forEach((x) =>
        x.classList.toggle('active', x === b));
    };
  });

  $('#btn-save').onclick = async () => {
    try { await saveDraft(); }
    catch (e) { showStage('stage-preview'); showError(e.message); }
  };
  $('#btn-redo').onclick = () => showStage('stage-record');
  $('#btn-error-retry').onclick = hideError;
  $('#btn-done-close').onclick = closeSheet;
  $('#btn-done-again').onclick = () => showStage('stage-record');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

function loadSettingsForm() {
  $('#input-groq').value = settings.groqKey;
  $('#input-pat').value = settings.pat;
  $('#input-repo').value = settings.repo;
}

document.addEventListener('DOMContentLoaded', init);
