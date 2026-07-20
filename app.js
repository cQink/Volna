/* ================= Волна — личный музыкальный плеер (v2) =================
   Источники: Audius (официальное API) + YouTube (Piped/Invidious, а если
   они не работают — запасной режим через официальный встроенный YT-плеер).
========================================================================== */
'use strict';

const APP = 'volna-player';

/* ---------- серверы по умолчанию ---------- */
const DEF_PIPED = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.ducks.party',
  'https://piped-api.codespace.cz',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.drgns.space',
  'https://pipedapi.owo.si',
];
const DEF_INV = [
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
  'https://invidious.f5.si',
  'https://iv.melmac.space',
  'https://invidious.privacyredirect.com',
  'https://id.420129.xyz',
  'https://invidious.materialio.us',
];
const AUDIUS_FALLBACK = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://discoveryprovider3.audius.co',
];

/* ---------- хранилище ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let pipedHosts = store.get('pipedHosts2', DEF_PIPED);
let invHosts   = store.get('invHosts2', DEF_INV);
let favs       = store.get('favs', []);

/* ---------- утилиты ---------- */
const $ = s => document.querySelector(s);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const fmt = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function fetchJSON(url, timeout = 6500) {
  return new Promise((resolve, reject) => {
    const ctl = new AbortController();
    const to = setTimeout(() => { ctl.abort(); reject(new Error('timeout')); }, timeout);
    fetch(url, { signal: ctl.signal })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { clearTimeout(to); resolve(j); })
      .catch(e => { clearTimeout(to); reject(e); });
  });
}
/* опрашиваем ВСЕ хосты параллельно, берём первый пригодный ответ */
function raceHosts(hosts, makeUrl, validate, timeout = 6500) {
  return new Promise((resolve, reject) => {
    let pending = hosts.length, done = false;
    if (!pending) return reject(new Error('нет серверов'));
    const fail = () => { if (--pending === 0 && !done) reject(new Error('все серверы недоступны')); };
    hosts.forEach(h => {
      fetchJSON(makeUrl(h), timeout).then(data => {
        if (!done && (!validate || validate(data))) { done = true; resolve({ host: h, data }); }
        else fail();
      }).catch(fail);
    });
  });
}

/* ---------- Audius ---------- */
let audiusHost = null;
async function getAudiusHost() {
  if (audiusHost) return audiusHost;
  try {
    const j = await fetchJSON('https://api.audius.co', 6000);
    if (j && j.data && j.data.length) { audiusHost = j.data[0]; return audiusHost; }
  } catch {}
  audiusHost = AUDIUS_FALLBACK[0];
  return audiusHost;
}
function audiusTrack(t) {
  return {
    src: 'audius', id: t.id,
    title: t.title || '—',
    artist: (t.user && t.user.name) || '—',
    art: (t.artwork && (t.artwork['480x480'] || t.artwork['150x150'])) || '',
    dur: t.duration || 0,
  };
}
async function audiusSearch(q) {
  const host = await getAudiusHost();
  const j = await fetchJSON(`${host}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=${APP}`, 9000);
  return (j.data || []).map(audiusTrack);
}
async function audiusTrending(genre) {
  const host = await getAudiusHost();
  const g = genre ? `&genre=${encodeURIComponent(genre)}` : '';
  const j = await fetchJSON(`${host}/v1/tracks/trending?app_name=${APP}${g}`, 9000);
  return (j.data || []).slice(0, 40).map(audiusTrack);
}
async function audiusStreamUrl(track) {
  const host = await getAudiusHost();
  return `${host}/v1/tracks/${track.id}/stream?app_name=${APP}`;
}

/* ---------- YouTube: поиск ---------- */
function ytIdFromUrl(u) { const m = /v=([\w-]{11})/.exec(u || ''); return m ? m[1] : null; }

async function ytSearch(q) {
  /* Piped и Invidious опрашиваются одновременно — кто первый ответит */
  const piped = raceHosts(pipedHosts,
    h => `${h}/search?q=${encodeURIComponent(q)}&filter=music_songs`,
    d => d && Array.isArray(d.items) && d.items.length)
    .then(({ data }) => data.items
      .filter(i => i.url)
      .map(i => ({
        src: 'yt', id: ytIdFromUrl(i.url),
        title: i.title || '—', artist: i.uploaderName || '—',
        art: i.thumbnail || '', dur: i.duration || 0,
      })).filter(t => t.id));
  const inv = raceHosts(invHosts,
    h => `${h}/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
    d => Array.isArray(d) && d.length)
    .then(({ host, data }) => data.slice(0, 20).map(v => ({
      src: 'yt', id: v.videoId,
      title: v.title || '—', artist: v.author || '—',
      art: `${host}/vi/${v.videoId}/mqdefault.jpg`, dur: v.lengthSeconds || 0,
    })));
  return Promise.any([piped, inv]);
}

/* ---------- YouTube: звук ----------
   iOS Safari не играет webm/opus — нужен m4a (audio/mp4). */
async function ytStreamUrl(track) {
  try {
    const { data } = await raceHosts(pipedHosts,
      h => `${h}/streams/${track.id}`,
      d => d && Array.isArray(d.audioStreams) && d.audioStreams.length);
    const m4a = data.audioStreams
      .filter(s => /mp4|m4a/i.test(s.mimeType || '') && s.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const any = data.audioStreams.filter(s => s.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const pick = m4a[0] || any[0];
    if (pick) return pick.url;
    throw new Error('no streams');
  } catch {}
  const { host } = await raceHosts(invHosts,
    h => `${h}/api/v1/videos/${track.id}?fields=adaptiveFormats`,
    d => d && Array.isArray(d.adaptiveFormats) && d.adaptiveFormats.some(f => /audio\/mp4/.test(f.type || '')));
  return `${host}/latest_version?id=${track.id}&itag=140&local=true`;
}

/* ---------- запасной режим: официальный встроенный YouTube-плеер ---------- */
let ytApiPromise = null;
function loadYtApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve();
    const to = setTimeout(() => reject(new Error('yt api timeout')), 10000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(to); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { clearTimeout(to); reject(new Error('yt api load')); };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}
const emb = { player: null, timer: null, playing: false };
let embedNoteShown = false;

function stopEmbed() {
  clearInterval(emb.timer); emb.timer = null; emb.playing = false;
  if (emb.player) { try { emb.player.stopVideo(); } catch {} }
}
function startEmbedTimer() {
  clearInterval(emb.timer);
  emb.timer = setInterval(() => {
    if (mode !== 'embed' || !emb.player || !emb.player.getDuration) return;
    let d = 0, c = 0;
    try { d = emb.player.getDuration() || 0; c = emb.player.getCurrentTime() || 0; } catch {}
    if (d) {
      if (!seeking) {
        $('#seek').value = (c / d) * 1000;
        $('#mBar').style.width = (c / d) * 100 + '%';
      }
      $('#tCur').textContent = fmt(c); $('#tDur').textContent = fmt(d);
    }
  }, 500);
}
async function playEmbed(t, my) {
  await loadYtApi();
  if (my !== loadToken) return;
  if (!(window.YT && window.YT.Player)) throw new Error('yt api');
  mode = 'embed';
  audio.pause(); audio.removeAttribute('src');
  if (!$('#ytemb')) {
    const box = el('div');
    box.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;overflow:hidden';
    box.innerHTML = '<div id="ytemb"></div>';
    document.body.appendChild(box);
  }
  if (emb.player && emb.player.loadVideoById) {
    emb.player.loadVideoById(t.id);
  } else {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('player timeout')), 10000);
      emb.player = new YT.Player('ytemb', {
        width: 2, height: 2, videoId: t.id,
        playerVars: { playsinline: 1, autoplay: 1, controls: 0, disablekb: 1, origin: location.origin },
        events: {
          onReady: e => { clearTimeout(to); try { e.target.playVideo(); } catch {} resolve(); },
          onStateChange: e => {
            if (mode !== 'embed') return;
            const S = YT.PlayerState;
            if (e.data === S.ENDED) { playNext(); return; }
            emb.playing = e.data === S.PLAYING || e.data === S.BUFFERING;
            syncPlayIcons();
          },
          onError: () => { if (mode === 'embed' && my === loadToken) { toast('Этот трек не проигрывается, переключаю…'); playNext(); } },
        },
      });
    });
  }
  startEmbedTimer();
  if (current) $('#mA').textContent = current.artist;
  const badge = $('#pSrc');
  badge.textContent = 'YOUTUBE · встроенный режим';
  if (!embedNoteShown) {
    embedNoteShown = true;
    toast('YouTube-серверы не отвечают — играю через встроенный плеер. Перемотка работает, но при блокировке экрана трек ставится на паузу.', 5000);
  }
}

/* ---------- плеер ---------- */
const audio = $('#audio');
let queue = [];
let qi = -1;
let current = null;
let loadToken = 0;
let mode = 'audio';   // 'audio' | 'embed'

function isFav(t) { return favs.some(f => f.src === t.src && f.id === t.id); }
function toggleFav(t) {
  if (isFav(t)) { favs = favs.filter(f => !(f.src === t.src && f.id === t.id)); toast('Убрано из избранного'); }
  else { favs.unshift(t); toast('Добавлено в избранное ❤'); }
  store.set('favs', favs);
  renderFavs(); syncFavUI();
}

async function playTrack(list, index) {
  queue = list; qi = index;
  const t = list[index];
  current = t;
  const my = ++loadToken;
  stopEmbed(); mode = 'audio';
  updatePlayerUI(t, true);
  showMini();
  try {
    if (t.src === 'audius') {
      audio.src = await audiusStreamUrl(t);
      if (my !== loadToken) return;
      await audio.play();
      setMediaSession(t);
    } else {
      try {
        const url = await ytStreamUrl(t);
        if (my !== loadToken) return;
        audio.src = url;
        await audio.play();
        setMediaSession(t);
      } catch (e) {
        /* Piped/Invidious мертвы — официальный встроенный плеер */
        if (my !== loadToken) return;
        await playEmbed(t, my);
      }
    }
    if (my === loadToken && current) $('#mA').textContent = current.artist;
  } catch (e) {
    if (my !== loadToken) return;
    console.warn(e);
    toast('Не удалось включить трек, пробую следующий…');
    if (qi < queue.length - 1) playTrack(queue, qi + 1);
  }
}
function playNext() { if (qi < queue.length - 1) playTrack(queue, qi + 1); }
function playPrev() {
  if (mode === 'embed' && emb.player) {
    try { if (emb.player.getCurrentTime() > 4) { emb.player.seekTo(0, true); return; } } catch {}
  } else if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  if (qi > 0) playTrack(queue, qi - 1);
}
function togglePlay() {
  if (!current) return;
  if (mode === 'embed') {
    if (!emb.player) return;
    try { emb.playing ? emb.player.pauseVideo() : emb.player.playVideo(); } catch {}
  } else {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  }
}

/* Media Session — управление с экрана блокировки */
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist,
    artwork: t.art ? [{ src: t.art, sizes: '480x480', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('nexttrack', playNext);
  try {
    navigator.mediaSession.setActionHandler('seekto', d => {
      if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime);
      else audio.currentTime = d.seekTime;
    });
  } catch {}
}

/* ---------- UI: плеер ---------- */
const PLAY_D = 'M8 5v14l11-7z';
const PAUSE_D = 'M6 5h4v14H6zM14 5h4v14h-4z';
function updatePlayerUI(t, loading) {
  $('#pT').textContent = t.title; $('#pA').textContent = t.artist;
  $('#mT').textContent = t.title; $('#mA').textContent = loading ? 'загрузка…' : t.artist;
  $('#pArt').src = t.art || 'icon-512.png';
  $('#mArt').src = t.art || 'icon-512.png';
  const s = $('#pSrc');
  s.textContent = t.src === 'audius' ? 'AUDIUS' : 'YOUTUBE';
  s.className = 'src ' + (t.src === 'audius' ? 'audius' : 'yt');
  syncFavUI();
}
function syncFavUI() {
  if (!current) return;
  $('#pFav').classList.toggle('on', isFav(current));
}
function syncPlayIcons() {
  const playing = mode === 'embed' ? emb.playing : !audio.paused;
  const d = playing ? PAUSE_D : PLAY_D;
  $('#pPlayIcon').setAttribute('d', d);
  $('#mPlayIcon').setAttribute('d', d);
}
function showMini() { $('#mini').classList.add('show'); }

let seeking = false;
audio.addEventListener('timeupdate', () => {
  if (mode !== 'audio') return;
  if (!seeking && audio.duration) {
    $('#seek').value = (audio.currentTime / audio.duration) * 1000;
    $('#mBar').style.width = (audio.currentTime / audio.duration) * 100 + '%';
  }
  $('#tCur').textContent = fmt(audio.currentTime);
  $('#tDur').textContent = fmt(audio.duration || (current && current.dur));
  if ('mediaSession' in navigator && audio.duration) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: 1 }); } catch {}
  }
});
audio.addEventListener('play', syncPlayIcons);
audio.addEventListener('pause', syncPlayIcons);
audio.addEventListener('ended', () => { if (mode === 'audio') playNext(); });
audio.addEventListener('error', () => {
  if (mode !== 'audio' || !current || !audio.src) return;
  toast('Ошибка воспроизведения — переключаю…');
  playNext();
});
$('#seek').addEventListener('input', () => { seeking = true; });
$('#seek').addEventListener('change', () => {
  const v = $('#seek').value / 1000;
  if (mode === 'embed' && emb.player) {
    try { emb.player.seekTo(v * emb.player.getDuration(), true); } catch {}
  } else if (audio.duration) {
    audio.currentTime = v * audio.duration;
  }
  seeking = false;
});
$('#pPlay').onclick = togglePlay;
$('#mPlay').onclick = e => { e.stopPropagation(); togglePlay(); };
$('#pNext').onclick = playNext;
$('#mNext').onclick = e => { e.stopPropagation(); playNext(); };
$('#pPrev').onclick = playPrev;
$('#pFav').onclick = () => current && toggleFav(current);
$('#pClose').onclick = () => $('#player').classList.remove('open');
$('#mini').onclick = () => current && $('#player').classList.add('open');
$('#pMore').onclick = () => {
  if (!current) return;
  $('#player').classList.remove('open');
  switchView('search');
  $('#q').value = current.artist;
  doSearch();
};

/* ---------- списки треков ---------- */
function trackRow(t, list, i) {
  const row = el('div', 'track');
  if (current && current.src === t.src && current.id === t.id) row.classList.add('playing');
  const img = el('img'); img.loading = 'lazy'; img.src = t.art || 'icon-180.png'; img.alt = '';
  const meta = el('div', 'meta');
  const ti = el('div', 't'); ti.textContent = t.title;
  const ar = el('div', 'a'); ar.textContent = t.artist;
  meta.append(ti, ar);
  const dur = el('div', 'dur'); dur.textContent = t.dur ? fmt(t.dur) : '';
  const fav = el('button', 'fav' + (isFav(t) ? ' on' : ''));
  fav.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 21C7 16.6 3 13.3 3 9.3 3 6.4 5.2 4 8 4c1.6 0 3.1.8 4 2 .9-1.2 2.4-2 4-2 2.8 0 5 2.4 5 5.3 0 4-4 7.3-9 11.7z"/></svg>';
  fav.onclick = e => { e.stopPropagation(); toggleFav(t); fav.classList.toggle('on', isFav(t)); };
  row.append(img, meta, dur, fav);
  row.onclick = () => playTrack(list, i);
  return row;
}
function renderList(container, tracks) {
  container.innerHTML = '';
  tracks.forEach((t, i) => container.append(trackRow(t, tracks, i)));
}

/* ---------- поиск ---------- */
let srcMode = 'all';
document.querySelectorAll('#srcChips .chip').forEach(c => c.onclick = () => {
  document.querySelectorAll('#srcChips .chip').forEach(x => x.classList.remove('on'));
  c.classList.add('on'); srcMode = c.dataset.src;
  if ($('#q').value.trim()) doSearch();
});
async function doSearch() {
  const q = $('#q').value.trim();
  if (!q) return;
  $('#q').blur();
  const out = $('#searchResults');
  out.innerHTML = '<div class="spin"></div>';
  const wantYt = srcMode !== 'audius';
  const wantAu = srcMode !== 'yt';
  const [ytRes, auRes] = await Promise.allSettled([
    wantYt ? ytSearch(q) : Promise.resolve([]),
    wantAu ? audiusSearch(q) : Promise.resolve([]),
  ]);
  out.innerHTML = '';
  const yt = ytRes.status === 'fulfilled' ? ytRes.value : [];
  const au = auRes.status === 'fulfilled' ? auRes.value : [];
  if (wantYt) {
    const h = el('div', 'sec-title'); h.innerHTML = '<span class="src yt">YOUTUBE</span> ' + (yt.length ? '' : '<span style="color:var(--muted);font-weight:400;font-size:12.5px">' + (ytRes.status === 'rejected' ? 'серверы недоступны — загляни в Настройки' : 'ничего не нашлось') + '</span>');
    out.append(h);
    const box = el('div'); out.append(box); renderList(box, yt);
  }
  if (wantAu) {
    const h = el('div', 'sec-title'); h.innerHTML = '<span class="src audius">AUDIUS</span> ' + (au.length ? '' : '<span style="color:var(--muted);font-weight:400;font-size:12.5px">' + (auRes.status === 'rejected' ? 'сервер недоступен, проверь интернет' : 'ничего не нашлось') + '</span>');
    out.append(h);
    const box = el('div'); out.append(box); renderList(box, au);
  }
  if (!yt.length && !au.length) out.append(Object.assign(el('div', 'empty'), { textContent: 'Ничего не нашлось. Попробуй изменить запрос.' }));
}
$('#goSearch').onclick = doSearch;
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

/* ---------- тренды ---------- */
let trendsLoaded = false;
async function loadTrends(genre) {
  const out = $('#trendResults');
  out.innerHTML = '<div class="spin"></div>';
  try {
    const tr = await audiusTrending(genre || '');
    out.innerHTML = '';
    const h = el('div', 'sec-title'); h.innerHTML = '<span class="src audius">AUDIUS</span> Сейчас в трендах';
    out.append(h);
    const box = el('div'); out.append(box); renderList(box, tr);
    trendsLoaded = true;
  } catch {
    out.innerHTML = '<div class="empty">Не удалось загрузить тренды. Проверь интернет и попробуй ещё раз.</div>';
  }
}
document.querySelectorAll('#genreChips .chip').forEach(c => c.onclick = () => {
  document.querySelectorAll('#genreChips .chip').forEach(x => x.classList.remove('on'));
  c.classList.add('on'); loadTrends(c.dataset.g);
});

/* ---------- избранное ---------- */
function renderFavs() {
  const out = $('#favList');
  out.innerHTML = '';
  if (!favs.length) { out.innerHTML = '<div class="empty">Пока пусто. Жми ❤ у трека — он появится здесь.</div>'; return; }
  renderList(out, favs);
}

/* ---------- настройки ---------- */
function fillSettings() {
  $('#pipedList').value = pipedHosts.join('\n');
  $('#invList').value = invHosts.join('\n');
}
$('#saveSet').onclick = () => {
  const parse = v => v.split('\n').map(s => s.trim().replace(/\/+$/, '')).filter(s => /^https:\/\//.test(s));
  const p = parse($('#pipedList').value), i = parse($('#invList').value);
  if (p.length) pipedHosts = p;
  if (i.length) invHosts = i;
  store.set('pipedHosts2', pipedHosts); store.set('invHosts2', invHosts);
  fillSettings(); toast('Сохранено');
};
$('#resetSet').onclick = () => {
  pipedHosts = [...DEF_PIPED]; invHosts = [...DEF_INV];
  store.set('pipedHosts2', pipedHosts); store.set('invHosts2', invHosts);
  fillSettings(); toast('Настройки сброшены');
};
$('#checkSet').onclick = async () => {
  const out = $('#checkOut');
  const lines = [];
  const TESTID = 'dQw4w9WgXcQ';
  out.textContent = 'Проверяю… (поиск / звук)';
  for (const h of pipedHosts) {
    let s = '❌', a = '❌';
    try { const j = await fetchJSON(`${h}/search?q=test&filter=music_songs`, 6000); if (Array.isArray(j.items)) s = '✅'; } catch {}
    try { const j = await fetchJSON(`${h}/streams/${TESTID}`, 6000); if (Array.isArray(j.audioStreams) && j.audioStreams.length) a = '✅'; } catch {}
    lines.push(`${h.replace('https://','')} — поиск ${s}, звук ${a}`);
    out.innerHTML = lines.join('<br>');
  }
  for (const h of invHosts) {
    let s = '❌', a = '❌';
    try { const j = await fetchJSON(`${h}/api/v1/search?q=test&type=video`, 6000); if (Array.isArray(j)) s = '✅'; } catch {}
    try { const j = await fetchJSON(`${h}/api/v1/videos/${TESTID}?fields=adaptiveFormats`, 6000); if (j && Array.isArray(j.adaptiveFormats) && j.adaptiveFormats.length) a = '✅'; } catch {}
    lines.push(`${h.replace('https://','')} — поиск ${s}, звук ${a}`);
    out.innerHTML = lines.join('<br>');
  }
  lines.push('');
  try { await audiusSearch('test'); lines.push('✅ Audius — работает'); }
  catch { lines.push('❌ Audius — не отвечает'); }
  lines.push('Если звук ❌ у всех — YouTube-треки будут играть через встроенный плеер (без фонового режима).');
  out.innerHTML = lines.join('<br>');
};

/* ---------- вкладки ---------- */
function switchView(v) {
  ['search', 'trends', 'favs', 'settings'].forEach(x => {
    $('#view-' + x).classList.toggle('hidden', x !== v);
  });
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'trends' && !trendsLoaded) loadTrends('');
  if (v === 'favs') renderFavs();
  if (v === 'settings') fillSettings();
  $('#main').scrollTop = 0;
}
document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => switchView(b.dataset.view));

/* ---------- запуск ---------- */
fillSettings();
renderFavs();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
