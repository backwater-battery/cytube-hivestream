// ============================================================
// HiveStream v0.00.02
// WebTorrent P2P theater inside CyTube rooms
// https://github.com/backwater-battery/cytube-hivestream
// ============================================================
//
// CHANGELOG v0.00.02
// ─────────────────────────────────────────────────────────────
// FIX: Magnet URI display/parsing — CyTube wraps magnet: links
//      in <a href="..."> tags. decodeBody() now correctly
//      extracts the raw magnet from href attribute before
//      passing to cmdMagnet. Also fixed the args.join split
//      issue where '?' in magnet URI was being split on whitespace.
//
// NEW: Phase 2 Playlist Manager
//      - !hs add <magnet|url|hash>  — queue item
//      - !hs queue                  — show queue
//      - !hs next                   — skip to next
//      - !hs clear                  — clear queue
//      Auto-advance: when current item ends, next queued item
//      plays automatically. Coordinator relays queue state.
//      UI: collapsible queue panel below video.
//
// NEW: Tracker ping/status UI — shows which WSS trackers
//      are reachable so users have a built-in test/debug tool.
//      !hs trackers — pings all configured trackers
//
// ARCH: Version constant changed to file-name-based scheme
//       (00.00.02) to match repository naming convention.
// ============================================================

(function () {
'use strict';

const V = '0.00.02';
if (window.__HS === V) return;
window.__HS = V;

// ── CONFIG ───────────────────────────────────────────────────
const CFG = {
  cmd:        '!hs',
  seedOnly:   false,
  syncThres:  2.5,
  syncMs:     30000,
  chatBurst:  20,
  chatDelay:  100,

  trackers: [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.webtorrent.io',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.fastcast.nz',
    'wss://tracker.novage.com.ua',
    'wss://tracker.opentrackr.org:1337/announce',
    'wss://tracker.files.fm:7073/announce',
    'wss://peertube.cpy.re:443/tracker/socket',
    'wss://framatube.org:443/tracker/socket',
    'wss://tube.privacytools.io:443/tracker/socket',
    'wss://peertube.social:443/tracker/socket',
    'wss://video.ploud.fr:443/tracker/socket',
    'wss://tracker.dler.com:6969/announce',
    'wss://tracker.sloppyta.co:443/announce',
    'wss://tracker.lab.bg:443/announce',
    'wss://tracker.qu.ax:443/announce',
    'wss://wstracker.online',
    'wss://tracker.uw0.xyz:443/announce',
  ],

  searchApi: 'https://sepiasearch.org/api/v1/search/videos',
  topApi:    'https://framatube.org/api/v1/videos?sort=-trending&count=20&hasWebtorrentVideo=true',
  archiveApi: 'https://archive.org/advancedsearch.php',

  corsBlocklist: [
    'peertube.opencloud.lu',
    'video.lqdn.fr',
    'tube.extinctionrebellion.fr',
    'peertube.datagueule.tv',
    'tube.hoga.fr',
    'media.fsfe.org',
    'tilvids.com',
    'peertube.tv',
    'videos.lukesmith.xyz',
    'makertube.net',
  ],

  idbName:    'HiveStream4',
  idbVersion: 2,
};

// ── KNOWN HASHES ────────────────────────────────────────────
const KNOWN = {
  'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c': {
    name: 'Big Buck Bunny',
    torrentUrl: 'https://webtorrent.io/torrents/big-buck-bunny.torrent',
    ws: 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4',
    wsFallbacks: [
      'https://archive.org/download/BigBuckBunny/BigBuckBunny.mp4',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    ],
  },
  '08ada5a7a6183aae1e09d831df6748d566095a10': {
    name: 'Sintel',
    torrentUrl: 'https://webtorrent.io/torrents/sintel.torrent',
    ws: 'https://archive.org/download/Sintel/sintel-2048-surround.mp4',
    wsFallbacks: [
      'https://archive.org/download/Sintel_blender/sintel-1024-surround.mp4',
    ],
  },
  'a88fda5954e89178c372716a6a78b8180ed4dad3': {
    name: 'Tears of Steel',
    torrentUrl: 'https://webtorrent.io/torrents/tears-of-steel.torrent',
    ws: 'https://archive.org/download/tears-of-steel/tears_of_steel_1080p.mp4',
    wsFallbacks: [
      'https://archive.org/download/tears-of-steel/tears_of_steel_720p.mp4',
    ],
  },
  '6a9759bffd5c0af65319979fb7832189f4f3c35d': {
    name: 'Elephants Dream',
    torrentUrl: 'https://webtorrent.io/torrents/elephants-dream.torrent',
    ws: 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4',
    wsFallbacks: [
      'https://archive.org/download/ElephantsDream/ed_hd.avi',
    ],
  },
  'c9e15763f722f23e98a29decdfae341b98d53056': {
    name: 'Cosmos Laundromat',
    torrentUrl: 'https://webtorrent.io/torrents/cosmos-laundromat.torrent',
    ws: 'https://archive.org/download/CosmosLaundromat/Cosmos_Laundromat_1080p.mp4',
    wsFallbacks: [],
  },
  'e1e75eedb2e609e7aa38bf0a4b5e24c3a524c096': {
    name: 'Sintel (HD)',
    torrentUrl: 'https://webtorrent.io/torrents/sintel.torrent',
    ws: 'https://archive.org/download/Sintel/sintel-2048-surround.mp4',
    wsFallbacks: [
      'https://archive.org/download/Sintel/sintel-1024-surround.mp4',
    ],
  },
};

const WEBTORRENT_INSTANCES = [
  'tube.tchncs.de',
  'peertube.dsmouse.net',
  'framatube.org',
  'video.blendertube.de',
  'peertube.cpy.re',
  'peertube.social',
  'toobnix.org',
  'videos.danksquad.org',
  'share.tube',
  'video.rastapuls.com',
  'kolektiva.media',
  'spectra.video',
  'koreus.tv',
  'cuddly.tube',
];

// ── STATE ────────────────────────────────────────────────────
const S = {
  state:   'IDLE',
  wt:      null,
  torrent: null,
  video:   null,
  results: [],
  myName:  '',
  myRank:  -1,
  chatQueue:  [],
  chatTimer:  null,
  chatCount:  0,
  chatReset:  null,
  syncTimer: null,
  idb: null,
  videoAttached: false,
  activeWs: null,
  errorHandled: false,
  renderToTimer: null,
  playbackSource: 'P2P',
  hudTimer: null,

  // ── PLAYLIST STATE ──────────────────────────────────────────
  // Each item: { type: 'magnet'|'hash'|'pt', value: str, name: str }
  playlist: [],
  playlistPos: -1,   // index of currently playing item (-1 = not from playlist)
};

// ── LOGGING ──────────────────────────────────────────────────
const dbLines = [];

function dbWrite(level, args) {
  const ts = new Date().toTimeString().slice(0, 8);
  const msg = args.map(function (a) {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
    catch (e) { return String(a); }
  }).join(' ');
  const prefix = level === 'W' ? '⚠ ' : level === 'E' ? '✖ ' : '';
  const line = '[' + ts + '] ' + prefix + msg;
  dbLines.push(line);
  if (dbLines.length > 200) dbLines.shift();
  const el = document.getElementById('hs-dblog');
  if (el) { el.textContent = dbLines.slice(-50).join('\n'); el.scrollTop = el.scrollHeight; }
}

const log    = function () { dbWrite('L', Array.from(arguments)); console.log('[HS]', ...arguments); };
const warn   = function () { dbWrite('W', Array.from(arguments)); console.warn('[HS]', ...arguments); };
const errlog = function () { dbWrite('E', Array.from(arguments)); console.error('[HS]', ...arguments); };

// ── STATE TRANSITIONS ────────────────────────────────────────
function transition(newState) {
  log('state:', S.state, '→', newState);
  S.state = newState;
  updateStateUI(newState);
}

function updateStateUI(state) {
  const el = document.getElementById('hs-state');
  if (!el) return;
  const labels = {
    IDLE:      '○ idle',
    FETCHING:  '⟳ fetching',
    METADATA:  '⟳ metadata',
    BUFFERING: '▼ buffering',
    PLAYING:   '▶ playing',
    SEEDING:   '▲ seeding',
  };
  el.textContent = labels[state] || state;
  el.className = 'hs-state hs-state-' + state.toLowerCase();
}

// ── CHAT QUEUE ───────────────────────────────────────────────
function chat(text) {
  if (!window.socket) return;
  S.chatQueue.push(text);
  if (!S.chatTimer) flushChat();
}

function flushChat() {
  if (!S.chatQueue.length) { S.chatTimer = null; return; }
  if (!S.chatReset) {
    S.chatCount = 0;
    S.chatReset = setTimeout(function () { S.chatCount = 0; S.chatReset = null; }, 5000);
  }
  if (window.CHATTHROTTLE) {
    S.chatTimer = setTimeout(flushChat, 300);
    return;
  }
  socket.emit('chatMsg', { msg: S.chatQueue.shift() });
  S.chatCount++;
  const delay = S.chatCount < CFG.chatBurst ? 150 : CFG.chatDelay;
  S.chatTimer = setTimeout(flushChat, delay);
}

function relay(body) { chat(CFG.cmd + ' ' + body); }

// ── RELAY ENCODER/DECODER ────────────────────────────────────
function encodeRelay(hash, wsUrl) {
  const b64 = btoa(wsUrl).replace(/=/g, '');
  return '_i ' + hash + ' ' + b64;
}

function decodeRelay(hashArg, b64Arg) {
  const hash = hashArg.toLowerCase();
  let ws = '';
  try {
    const pad = b64Arg.length % 4;
    const padded = pad ? b64Arg + '='.repeat(4 - pad) : b64Arg;
    ws = atob(padded);
  } catch (e) {
    warn('base64 decode failed:', e.message);
  }
  return { hash, ws };
}

// ── FIX: decodeBody — correctly extracts magnet URIs from CyTube <a> tags ──
// CyTube wraps magnet: links: <a href="magnet:?xt=urn:btih:...">magnet:...</a>
// We must pull the href value, not the inner text, because CyTube may truncate
// the inner text for display but the href always has the full URI.
function decodeBody(body) {
  if (!body) return body;
  let s = body;
  if (s.indexOf('<') >= 0) {
    // Extract full href for magnet links BEFORE stripping tags
    // This preserves the complete magnet URI that would otherwise be truncated
    s = s.replace(/<a[^>]+href="(magnet:[^"]*)"[^>]*>[^<]*<\/a>/gi, function (_, href) {
      // Decode HTML entities in href (CyTube encodes & as &amp; in attrs)
      return href.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    });
    // For non-magnet links, use inner text (original behaviour)
    s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, function (_, href, text) {
      return text || href;
    });
    s = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return s;
}

// ── MAGNET BUILDER ───────────────────────────────────────────
function buildMagnet(hash, ws, dn) {
  let m = 'magnet:?xt=urn:btih:' + hash;
  if (dn) m += '&dn=' + encodeURIComponent(dn);
  if (ws) m += '&ws=' + encodeURIComponent(ws);
  CFG.trackers.forEach(function (tr) { m += '&tr=' + encodeURIComponent(tr); });
  return m;
}

// ── COORDINATOR DETECTION ────────────────────────────────────
function isCoordinator() {
  if (window.CLIENT && CLIENT.leader === true) return true;
  if (S.myRank < 1.5) return false;
  const items = Array.from(document.querySelectorAll('#userlist .userlist_item'));
  if (!items.length) return true;
  let highestOther = 0;
  items.forEach(function (el) {
    const sp = el.querySelector('span:nth-child(2)');
    const name = sp ? sp.textContent.trim() : '';
    if (!name || name === S.myName) return;
    const c = (el.className || '') + (sp ? (sp.className || '') : '');
    let r = 1;
    if (c.includes('userlist_siteadmin')) r = 255;
    else if (c.includes('userlist_owner')) r = 3;
    else if (c.includes('userlist_op')) r = 2;
    if (r > highestOther) highestOther = r;
  });
  return S.myRank >= highestOther;
}

// ── WEBTORRENT CLIENT ────────────────────────────────────────
function mkClient() {
  const wt = new window.WebTorrent({
    tracker: {
      rtcConfig: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
          { urls: 'stun:stun.stunprotocol.org:3478' },
          { urls: 'stun:stun.ekiga.net' },
        ]
      }
    }
  });
  wt.on('error', function (e) { errlog('WT client:', e.message || e); });
  return wt;
}

function startSwarmThenRelay(hash, ws, dn) {
  if (S.state !== 'IDLE') { log('startSwarmThenRelay: not IDLE, ignoring'); return; }
  if (!S.wt) S.wt = mkClient();
  S.activeWs = ws || null;

  if (ws) {
    log('webseed available — starting HTTP playback immediately');
    transition('BUFFERING');
    relay(encodeRelay(hash, ws));
    attachVideo(null, ws);
    startSyncTimer();
    const el = document.getElementById('currenttitle');
    if (el) el.textContent = dn || hash.slice(0, 8);
    idbGetTorrent(hash, function (cachedBuf) {
      const magnet = buildMagnet(hash, ws, dn);
      let t;
      try {
        t = cachedBuf ? S.wt.add(new Uint8Array(cachedBuf), { announce: CFG.trackers }) : S.wt.add(magnet);
      } catch (e) {
        t = S.wt.get(hash);
        if (!t) { warn('background wt.add failed:', e.message); return; }
      }
      S.torrent = t;
      t.on('metadata', function () {
        log('background metadata:', t.name, '— now seeding to peers');
        if (t.pieces && t.pieces.length > 0) {
          const critEnd = Math.max(0, Math.floor(t.pieces.length * 0.05) - 1);
          try { t.critical(0, critEnd); } catch(e) {}
        }
        startHUD(t);
      });
      t.on('done', function () {
        log('background done — seeding:', t.name);
        transition('SEEDING');
        idbStoreTorrent(t);
        chat('Seeding "' + (t.name || dn) + '" to room');
      });
      t.on('wire', function (wire) {
        log('peer connected:', wire.remoteAddress || 'webrtc', '— total:', t.numPeers);
      });
      t.on('warning', function (w) { warn('torrent:', w.message || w); });
      t.on('error', function (e) {
        const msg = e.message || String(e);
        if (msg.indexOf('duplicate') >= 0) return;
        warn('background torrent error:', msg);
      });
    });
    return;
  }

  transition('METADATA');
  idbGetTorrent(hash, function (cachedBuf) {
    const magnet = buildMagnet(hash, ws, dn);
    let t;
    try {
      t = cachedBuf ? S.wt.add(new Uint8Array(cachedBuf), { announce: CFG.trackers }) : S.wt.add(magnet);
    } catch (e) {
      t = S.wt.get(hash);
      if (!t) { errlog('startSwarmThenRelay add failed:', e.message); transition('IDLE'); return; }
    }
    S.torrent = t;
    relay('_i ' + hash + ' -');
    bindTorrent(t);
  });
}

function startSwarm(hash, ws, dn) {
  if (S.state !== 'IDLE') {
    log('startSwarm: not IDLE (state=' + S.state + '), ignoring');
    return;
  }
  if (!S.wt) S.wt = mkClient();
  transition('METADATA');

  idbGetTorrent(hash, function (cachedBuf) {
    const magnet = buildMagnet(hash, ws, dn);
    S.activeWs = ws || null;
    log('adding magnet, ws=' + (ws ? ws.slice(0, 60) : 'none'));

    let t;
    try {
      if (cachedBuf) {
        log('IDB cache hit for', hash, '— loading as seed');
        t = S.wt.add(new Uint8Array(cachedBuf), { announce: CFG.trackers });
      } else {
        t = S.wt.add(magnet);
      }
    } catch (e) {
      log('wt.add error:', e.message, '— trying wt.get for', hash);
      t = S.wt.get(hash);
      if (!t) {
        errlog('wt.get also failed, recreating client');
        S.wt.destroy(function () {
          S.wt = mkClient();
          const t2 = S.wt.add(magnet);
          S.torrent = t2;
          bindTorrent(t2);
        });
        return;
      }
      log('recovered existing torrent from wt.get');
    }

    S.torrent = t;
    bindTorrent(t);
  });
}

function bindTorrent(t) {
  t.on('infoHash', function () {
    log('infoHash:', t.infoHash);
  });

  t.on('metadata', function () {
    log('metadata:', t.name, '— files:', t.files.length);
    if (t.pieces && t.pieces.length > 0) {
      const critEnd = Math.max(0, Math.floor(t.pieces.length * 0.05) - 1);
      try { t.critical(0, critEnd); log('critical 0-' + critEnd + '/' + t.pieces.length); }
      catch (e) {}
    }
    transition('BUFFERING');
    chat('"' + t.name + '" — buffering…');
    const el = document.getElementById('currenttitle');
    if (el) el.textContent = t.name;
    attachVideo(t, S.activeWs);
    startHUD(t);
    startSyncTimer();
  });

  t.on('ready', function () {
    log('ready:', t.name);
    transition('PLAYING');
    chat('"' + t.name + '" ready — ' + t.numPeers + ' peer(s)');
  });

  t.on('done', function () {
    log('done — seeding');
    transition('SEEDING');
    idbStoreTorrent(t);
    chat('Seeding "' + t.name + '" to room');
  });

  t.on('wire', function (wire) {
    log('peer connected:', wire.remoteAddress || 'webrtc', '— total:', t.numPeers);
  });

  t.on('warning', function (w) { warn('torrent warn:', w.message || w); });
  t.on('error', function (e) {
    const msg = e.message || String(e);
    errlog('torrent error:', msg);
    if (msg.indexOf('duplicate') >= 0 && t.infoHash) {
      const existing = S.wt.get(t.infoHash);
      if (existing && existing !== t) {
        log('duplicate recovery: rebinding to existing torrent', t.infoHash);
        S.torrent = existing;
        if (existing.files && existing.files.length) {
          transition('BUFFERING');
          attachVideo(existing, S.activeWs); startHUD(existing); startSyncTimer();
        } else {
          transition('METADATA');
          bindTorrent(existing);
        }
        return;
      }
    }
    transition('IDLE');
    setOverlay('Error: ' + msg);
    // On error, try playlist advance
    playlistAdvance();
  });
}

function attachVideo(t, wsUrl) {
  if (S.videoAttached) { log('attachVideo: already attached, skipping'); return; }
  S.videoAttached = true;

  const overlay = document.getElementById('hs-overlay');
  if (overlay) overlay.style.display = 'none';

  if (!t) {
    if (wsUrl) { log('no torrent, HTTP direct:', wsUrl.slice(0, 80)); httpFallback(wsUrl); }
    else { errlog('attachVideo: no torrent and no wsUrl'); }
    return;
  }

  const PLAYABLE = /\.(mp4|webm|mkv|mov|ogv|ogg|m4v)$/i;
  let best = null;
  t.files.forEach(function (f) {
    if (!best) { best = f; return; }
    const fv = PLAYABLE.test(f.name), bv = PLAYABLE.test(best.name);
    if (fv && !bv) { best = f; return; }
    if (f.length > best.length) best = f;
  });

  if (!best) {
    errlog('no playable file in torrent');
    if (wsUrl) httpFallback(wsUrl);
    return;
  }

  const BLOB_LIMIT = 200 * 1024 * 1024;
  if (best.length > BLOB_LIMIT) {
    log('file too large for renderTo (' + Math.round(best.length/1e6) + 'MB > 200MB limit) — going direct HTTP');
    if (wsUrl) httpFallback(wsUrl);
    else { setOverlay('File too large for P2P playback. No webseed available.'); transition('IDLE'); }
    return;
  }

  log('P2P renderTo attempt:', best.name, '(' + Math.round(best.length / 1e6) + 'MB)');
  setOverlay('P2P streaming…');

  var errorFired = false;

  S.video.onplaying = function () {
    log('P2P playing readyState=' + S.video.readyState);
    S.playbackSource = 'P2P';
    setOverlay('');
    hideTapOverlay();
    if (S.renderToTimer) { clearTimeout(S.renderToTimer); S.renderToTimer = null; }
  };
  S.video.oncanplay = function () {
    log('canplay paused=' + S.video.paused + ' readyState=' + S.video.readyState);
    if (S.video.paused && S.video.currentTime < 0.5) showTapOverlay();
  };
  // Wire 'ended' event for playlist auto-advance
  S.video.onended = function () {
    log('video ended — checking playlist');
    playlistAdvance();
  };
  S.video.onerror = function () {
    if (errorFired) return;
    errorFired = true;
    const msg = S.video.error ? S.video.error.message : 'unknown';
    errlog('video error during P2P:', msg);
    if (S.renderToTimer) { clearTimeout(S.renderToTimer); S.renderToTimer = null; }
    S.video.onerror = null;
    S.video.onplaying = null;
    S.video.oncanplay = null;
    S.video.removeAttribute('src');
    S.video.load();
    if (wsUrl) {
      warn('P2P failed — switching to HTTP');
      httpFallback(wsUrl);
    } else {
      setOverlay('Playback failed. Try !hs stop.');
      if (S.state !== 'IDLE') transition('IDLE');
    }
  };

  best.renderTo(S.video, function (err) {
    if (err) {
      if (errorFired) return;
      errorFired = true;
      errlog('renderTo error:', err.message);
      S.videoAttached = false;
      S.video.onerror = null;
      S.video.onplaying = null;
      S.video.oncanplay = null;
      if (wsUrl) httpFallback(wsUrl);
      return;
    }
    log('renderTo attached readyState=' + S.video.readyState);

    if (S.renderToTimer) clearTimeout(S.renderToTimer);
    S.renderToTimer = setTimeout(function () {
      S.renderToTimer = null;
      if (errorFired) return;
      if (S.video.readyState <= 1 && S.video.paused) {
        warn('renderTo stalled readyState=' + S.video.readyState + ' — not fMP4, HTTP fallback');
        errorFired = true;
        S.video.onerror = null;
        S.video.onplaying = null;
        S.video.oncanplay = null;
        if (wsUrl) httpFallback(wsUrl);
        else { setOverlay('Cannot play this format. Try !hs stop.'); transition('IDLE'); }
      } else {
        log('P2P mode active readyState=' + S.video.readyState);
      }
    }, 8000);
  });
}

function httpFallback(wsUrl) {
  log('HTTP fallback:', wsUrl.slice(0, 80));
  try { S.playbackSource = 'HTTP:' + new URL(wsUrl).hostname; } catch(e) { S.playbackSource = 'HTTP'; }
  setOverlay('');
  var fallbacks = [];
  if (S.torrent && S.torrent.infoHash) {
    var k = KNOWN[S.torrent.infoHash];
    if (k && k.wsFallbacks) fallbacks = k.wsFallbacks.slice();
  }
  playDirect(wsUrl, fallbacks);
}

function playDirect(url, fallbacks) {
  S.errorHandled = false;
  wireVideoEvents(url, fallbacks || []);
  S.video.src = url;
  S.video.load();
  log('trying URL:', url.slice(0, 90));
  const p = S.video.play();
  if (p && typeof p.then === 'function') {
    p.then(function () {
      log('direct play started');
    }).catch(function (e) {
      if (S.errorHandled) { log('play() catch suppressed — onerror already handled'); return; }
      log('direct play blocked (' + e.message + ') — showing tap overlay');
      showTapOverlay();
    });
  }
}

function wireVideoEvents(currentUrl, fallbacks) {
  S.video.onplaying = function () {
    log('video playing readyState=' + S.video.readyState);
    if (currentUrl) {
      try { S.playbackSource = 'HTTP:' + new URL(currentUrl).hostname.replace('www.',''); }
      catch(e) { S.playbackSource = 'HTTP'; }
    }
    if (S.state === 'BUFFERING' || S.state === 'METADATA') transition('PLAYING');
    hideTapOverlay();
  };
  var canplayDebounce = null;
  S.video.oncanplay = function () {
    if (canplayDebounce) clearTimeout(canplayDebounce);
    canplayDebounce = setTimeout(function () {
      canplayDebounce = null;
      if (S.video && S.video.paused && S.video.readyState >= 3) {
        log('canplay: video paused after buffer — showing tap overlay');
        showTapOverlay();
      }
    }, 800);
  };
  // Wire ended event for playlist auto-advance
  S.video.onended = function () {
    log('video ended (HTTP) — checking playlist');
    playlistAdvance();
  };
  S.video.onerror = function () {
    const err = S.video.error;
    const msg = err ? err.message : 'unknown error';
    const code = err ? err.code : 0;
    errlog('video error code=' + code + ':', msg);
    S.errorHandled = true;

    if (fallbacks && fallbacks.length > 0) {
      const next = fallbacks[0];
      const rest = fallbacks.slice(1);
      warn('URL failed, trying fallback:', next.slice(0, 80));
      chat('⚠ URL failed — trying fallback…');
      S.video.removeAttribute('src');
      S.video.load();
      S.errorHandled = false;
      wireVideoEvents(next, rest);
      S.video.src = next;
      S.video.load();
      const p = S.video.play();
      if (p && typeof p.then === 'function') {
        p.then(function () { log('fallback play started'); })
         .catch(function (e) {
           if (!S.errorHandled) {
             log('fallback play blocked:', e.message);
             showTapOverlay();
           }
         });
      }
      return;
    }

    S.video.removeAttribute('src');
    S.video.load();
    S.videoAttached = false;
    const hint = 'All URLs failed (' + msg + '). Try !hs stop and pick another video.';
    setOverlay(hint);
    chat('⚠ ' + hint);
    if (S.state !== 'IDLE') transition('IDLE');
    // Auto-advance playlist on failure
    playlistAdvance();
  };
}

function showTapOverlay() {
  const old = document.getElementById('hs-tap');
  if (old) old.remove();
  const tap = document.createElement('div');
  tap.id = 'hs-tap';
  tap.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;cursor:pointer;z-index:10;' +
    'background:rgba(0,0,0,0.55);';
  tap.innerHTML =
    '<div style="font-size:64px;line-height:1;text-shadow:0 0 30px #39ff14">▶</div>' +
    '<div style="color:#39ff14;font:13px Courier New,monospace;margin-top:8px">tap to play</div>';
  tap.onclick = function () {
    S.video.muted = true;
    const p = S.video.play();
    if (p && typeof p.then === 'function') {
      p.catch(function (e) { errlog('tap play() failed:', e.message); });
    }
  };
  const vwrap = document.getElementById('hs-vwrap');
  if (vwrap) vwrap.appendChild(tap);
}

function hideTapOverlay() {
  const el = document.getElementById('hs-tap');
  if (el) el.remove();
}

function showUnmuteBtn() {
  if (document.getElementById('hs-unmute')) return;
  const btn = document.createElement('button');
  btn.id = 'hs-unmute';
  btn.textContent = '🔇 tap to unmute';
  btn.style.cssText =
    'position:absolute;bottom:40px;left:50%;transform:translateX(-50%);' +
    'background:rgba(0,0,0,0.8);color:#39ff14;border:1px solid #39ff14;' +
    'font:12px Courier New,monospace;padding:6px 16px;cursor:pointer;z-index:11;' +
    'border-radius:3px;';
  btn.onclick = function () {
    S.video.muted = false;
    btn.remove();
    log('unmuted by user');
  };
  const vwrap = document.getElementById('hs-vwrap');
  if (vwrap) vwrap.appendChild(btn);
}

// ── HUD ──────────────────────────────────────────────────────
function startHUD(t) {
  if (S.hudTimer) clearInterval(S.hudTimer);
  S.hudTimer = setInterval(function () {
    if (!S.torrent && !t) { clearInterval(S.hudTimer); S.hudTimer = null; return; }
    const _t = S.torrent || t;
    const pct = _t.length ? (_t.downloaded / _t.length * 100).toFixed(1) : '?';
    const spd = fmtSpd(_t.downloadSpeed) + '▼ ' + fmtSpd(_t.uploadSpeed) + '▲';
    const src = S.playbackSource || 'P2P';
    const txt = '[' + src + '] ' + pct + '% · '
