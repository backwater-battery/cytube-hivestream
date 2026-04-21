// ============================================================
// HiveStream v0.00.05
// WebTorrent P2P theater inside CyTube rooms
// https://github.com/backwater-battery/cytube-hivestream
// ============================================================
//
// CHANGELOG v0.00.05
// ─────────────────────────────────────────────────────────────
// FIX: Magnet metadata timeout — when a magnet connects to a
//      peer but never receives torrent info (ut_metadata stall),
//      the state was stuck at ⟳ metadata forever with no feedback.
//      Now: 45s timeout fires, shows clear overlay message,
//      transitions back to IDLE, and auto-advances playlist.
//      Timer starts on infoHash event, cancelled on metadata
//      event, on error, and on stopAll().
//
// FIX: Suppress no-op state transitions (IDLE→IDLE) in log.
//      transition() now returns early if state hasn't changed.
//
// CARRY: All v0.00.04 fixes (b64 decode, codec detection,
//        ghost PLAYING state, peers button, wire HUD).
// ============================================================
(function(){
'use strict';

const V='0.00.05';
if(window.__HS===V)return;
window.__HS=V;

const CFG={
  cmd:'!hs',
  seedOnly:false,
  syncThres:2.5,
  syncMs:30000,
  chatBurst:20,
  chatDelay:100,
  trackers:[
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
  searchApi:'https://sepiasearch.org/api/v1/search/videos',
  topApi:'https://framatube.org/api/v1/videos?sort=-trending&count=20&hasWebtorrentVideo=true',
  archiveApi:'https://archive.org/advancedsearch.php',
  corsBlocklist:[
    'peertube.opencloud.lu','video.lqdn.fr','tube.extinctionrebellion.fr',
    'peertube.datagueule.tv','tube.hoga.fr','media.fsfe.org',
    'tilvids.com','peertube.tv','videos.lukesmith.xyz','makertube.net',
  ],
  idbName:'HiveStream4',
  idbVersion:2,
};

const KNOWN={
  'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c':{name:'Big Buck Bunny',torrentUrl:'https://webtorrent.io/torrents/big-buck-bunny.torrent',ws:'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4',wsFallbacks:['https://archive.org/download/BigBuckBunny/BigBuckBunny.mp4','https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4']},
  '08ada5a7a6183aae1e09d831df6748d566095a10':{name:'Sintel',torrentUrl:'https://webtorrent.io/torrents/sintel.torrent',ws:'https://archive.org/download/Sintel/sintel-2048-surround.mp4',wsFallbacks:['https://archive.org/download/Sintel_blender/sintel-1024-surround.mp4']},
  'a88fda5954e89178c372716a6a78b8180ed4dad3':{name:'Tears of Steel',torrentUrl:'https://webtorrent.io/torrents/tears-of-steel.torrent',ws:'https://archive.org/download/tears-of-steel/tears_of_steel_1080p.mp4',wsFallbacks:['https://archive.org/download/tears-of-steel/tears_of_steel_720p.mp4']},
  '6a9759bffd5c0af65319979fb7832189f4f3c35d':{name:'Elephants Dream',torrentUrl:'https://webtorrent.io/torrents/elephants-dream.torrent',ws:'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4',wsFallbacks:[]},
  'c9e15763f722f23e98a29decdfae341b98d53056':{name:'Cosmos Laundromat',torrentUrl:'https://webtorrent.io/torrents/cosmos-laundromat.torrent',ws:'https://archive.org/download/CosmosLaundromat/Cosmos_Laundromat_1080p.mp4',wsFallbacks:[]},
};

const WEBTORRENT_INSTANCES=[
  'tube.tchncs.de','peertube.dsmouse.net','framatube.org','video.blendertube.de',
  'peertube.cpy.re','peertube.social','toobnix.org','videos.danksquad.org',
  'share.tube','video.rastapuls.com','kolektiva.media','spectra.video',
];

const S={
  state:'IDLE',wt:null,torrent:null,video:null,
  results:[],myName:'',myRank:-1,
  chatQueue:[],chatTimer:null,chatCount:0,chatReset:null,
  syncTimer:null,idb:null,videoAttached:false,
  activeWs:null,errorHandled:false,renderToTimer:null,
  playbackSource:'P2P',hudTimer:null,
  playlist:[],playlistPos:-1,
  metadataTimer:null,
};

// ── LOGGING ──────────────────────────────────────────────────
const dbLines=[];
function dbWrite(level,args){
  const ts=new Date().toTimeString().slice(0,8);
  const msg=args.map(function(a){
    if(a===null)return'null';if(a===undefined)return'undefined';
    try{return typeof a==='object'?JSON.stringify(a):String(a);}catch(e){return String(a);}
  }).join(' ');
  const pre=level==='W'?'⚠ ':level==='E'?'✖ ':'';
  dbLines.push('['+ts+'] '+pre+msg);
  if(dbLines.length>300)dbLines.shift();
  const el=document.getElementById('hs-dblog');
  if(el){el.textContent=dbLines.slice(-60).join('\n');el.scrollTop=el.scrollHeight;}
}
function log(){dbWrite('L',Array.from(arguments));console.log('[HS]',...arguments);}
function warn(){dbWrite('W',Array.from(arguments));console.warn('[HS]',...arguments);}
function errlog(){dbWrite('E',Array.from(arguments));console.error('[HS]',...arguments);}

// ── STATE ────────────────────────────────────────────────────
function transition(ns){
  if(S.state===ns)return; // suppress no-op transitions
  log('state:',S.state,'→',ns);S.state=ns;
  const el=document.getElementById('hs-state');if(!el)return;
  const L={IDLE:'○ idle',FETCHING:'⟳ fetching',METADATA:'⟳ metadata',BUFFERING:'▼ buffering',PLAYING:'▶ playing',SEEDING:'▲ seeding'};
  el.textContent=L[ns]||ns;
  el.className='hs-state hs-state-'+ns.toLowerCase();
}

// ── CHAT ─────────────────────────────────────────────────────
function chat(text){if(!window.socket)return;S.chatQueue.push(text);if(!S.chatTimer)flushChat();}
function flushChat(){
  if(!S.chatQueue.length){S.chatTimer=null;return;}
  if(!S.chatReset){S.chatCount=0;S.chatReset=setTimeout(function(){S.chatCount=0;S.chatReset=null;},5000);}
  if(window.CHATTHROTTLE){S.chatTimer=setTimeout(flushChat,300);return;}
  socket.emit('chatMsg',{msg:S.chatQueue.shift()});
  S.chatCount++;
  S.chatTimer=setTimeout(flushChat,S.chatCount<CFG.chatBurst?150:CFG.chatDelay);
}
function relay(body){chat(CFG.cmd+' '+body);}

// ── RELAY CODEC ──────────────────────────────────────────────
function encodeRelay(hash,wsUrl){return '_i '+hash+' '+btoa(wsUrl).replace(/=/g,'');}
// FIX: '-' means no webseed — skip atob
function decodeRelay(hashArg,b64Arg){
  const hash=(hashArg||'').toLowerCase();
  const b=b64Arg||'';
  if(!b||b==='-'||b.length<4)return{hash,ws:''};
  let ws='';
  try{const pad=b.length%4;ws=atob(pad?b+'='.repeat(4-pad):b);}
  catch(e){warn('b64 decode:',e.message);}
  return{hash,ws};
}

// ── DECODE BODY ───────────────────────────────────────────────
function decodeBody(body){
  if(!body)return body;
  let s=body;
  if(s.indexOf('<')>=0){
    s=s.replace(/<a[^>]+href="(magnet:[^"]*)"[^>]*>[^<]*<\/a>/gi,function(_,href){return href.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');}); 
    s=s.replace(/<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi,function(_,href,text){return text||href;});
    s=s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  }
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
}

// ── MAGNET ────────────────────────────────────────────────────
function buildMagnet(hash,ws,dn){
  let m='magnet:?xt=urn:btih:'+hash;
  if(dn)m+='&dn='+encodeURIComponent(dn);
  if(ws)m+='&ws='+encodeURIComponent(ws);
  CFG.trackers.forEach(function(tr){m+='&tr='+encodeURIComponent(tr);});
  return m;
}

// ── SYNTHETIC HASH from URL ───────────────────────────────────
function hashFromUrl(url){
  let h1=5381,h2=52711;
  for(let i=0;i<url.length;i++){
    const c=url.charCodeAt(i);
    h1=((h1<<5)+h1)^c;h2=((h2<<5)+h2)^c;
    h1=h1>>>0;h2=h2>>>0;
  }
  let hex='';
  for(let i=0;i<5;i++){
    hex+=('00000000'+((h1^(h1>>>(i*3+1)))>>>0).toString(16)).slice(-4);
    hex+=('00000000'+((h2^(h2<<(i*2+1)))>>>0).toString(16)).slice(-4);
  }
  return hex.slice(0,40);
}

// ── COORDINATOR ──────────────────────────────────────────────
function isCoordinator(){
  if(window.CLIENT&&CLIENT.leader===true)return true;
  if(S.myRank>=3)return true;
  if(S.myRank<1.5)return false;
  const items=Array.from(document.querySelectorAll('#userlist .userlist_item'));
  if(!items.length)return true;
  let high=0;
  items.forEach(function(el){
    const sp=el.querySelector('span:nth-child(2)');
    const name=sp?sp.textContent.trim():'';
    if(!name||name===S.myName)return;
    const c=(el.className||'')+(sp?sp.className||'':'');
    let r=1;
    if(c.includes('userlist_siteadmin'))r=255;
    else if(c.includes('userlist_owner'))r=3;
    else if(c.includes('userlist_op'))r=2;
    if(r>high)high=r;
  });
  return S.myRank>=high;
}

// ── CODEC DETECTION ──────────────────────────────────────────
function filenameHasHevc(name){return/x265|h\.265|hevc|10bit/i.test(name);}
function checkCodec(filename){
  const ext=(filename.split('.').pop()||'').toLowerCase();
  const v=document.createElement('video');
  if(ext==='mkv'||ext==='avi'||ext==='wmv'||ext==='flv')
    return{playable:false,reason:'Container .'+ext+' not supported in browsers (needs MP4/WebM)'};
  if(ext==='mp4'||ext==='m4v'){
    const h264=v.canPlayType('video/mp4; codecs="avc1.42E01E"');
    if(h264==='probably'||h264==='maybe')return{playable:true,reason:'MP4/H.264 ok'};
    return{playable:false,reason:'MP4 but no H.264 support found'};
  }
  if(ext==='webm'){
    const vp9=v.canPlayType('video/webm; codecs="vp9"');
    const vp8=v.canPlayType('video/webm; codecs="vp8"');
    if(vp9==='probably'||vp9==='maybe'||vp8==='probably'||vp8==='maybe')return{playable:true,reason:'WebM ok'};
    return{playable:false,reason:'WebM but no VP8/VP9 support'};
  }
  return{playable:true,reason:'Unknown ext .'+ext+' — attempting playback'};
}

// ── WEBTORRENT CLIENT ────────────────────────────────────────
function mkClient(){
  const wt=new window.WebTorrent({tracker:{rtcConfig:{iceServers:[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:stun2.l.google.com:19302'},
    {urls:'stun:global.stun.twilio.com:3478'},
    {urls:'stun:stun.stunprotocol.org:3478'},
    {urls:'stun:stun.ekiga.net'},
  ]}}});
  wt.on('error',function(e){errlog('WT client:',e.message||e);});
  return wt;
}

// ── SWARM ────────────────────────────────────────────────────
function startSwarmThenRelay(hash,ws,dn){
  if(S.state!=='IDLE'){log('not IDLE');return;}
  if(!S.wt)S.wt=mkClient();
  S.activeWs=ws||null;
  if(ws){
    transition('BUFFERING');
    relay(encodeRelay(hash,ws));
    attachVideo(null,ws);
    startSyncTimer();
    const te=document.getElementById('currenttitle');if(te)te.textContent=dn||hash.slice(0,8);
    idbGetTorrent(hash,function(buf){
      let t;
      try{t=buf?S.wt.add(new Uint8Array(buf),{announce:CFG.trackers}):S.wt.add(buildMagnet(hash,ws,dn));}
      catch(e){t=S.wt.get(hash);if(!t){warn('bg add failed:',e.message);return;}}
      S.torrent=t;
      bindBgTorrent(t,dn);
    });
    return;
  }
  transition('METADATA');
  idbGetTorrent(hash,function(buf){
    let t;
    try{t=buf?S.wt.add(new Uint8Array(buf),{announce:CFG.trackers}):S.wt.add(buildMagnet(hash,null,dn));}
    catch(e){t=S.wt.get(hash);if(!t){errlog('add failed:',e.message);transition('IDLE');return;}}
    S.torrent=t;
    relay('_i '+hash+' -');
    bindTorrent(t);
  });
}

function startSwarm(hash,ws,dn){
  if(S.state!=='IDLE'){log('not IDLE');return;}
  if(!S.wt)S.wt=mkClient();
  transition('METADATA');
  S.activeWs=ws||null;
  idbGetTorrent(hash,function(buf){
    let t;
    try{t=buf?S.wt.add(new Uint8Array(buf),{announce:CFG.trackers}):S.wt.add(buildMagnet(hash,ws,dn));}
    catch(e){
      t=S.wt.get(hash);
      if(!t){S.wt.destroy(function(){S.wt=mkClient();S.torrent=S.wt.add(buildMagnet(hash,ws,dn));bindTorrent(S.torrent);});return;}
    }
    S.torrent=t;bindTorrent(t);
  });
}

function bindBgTorrent(t,dn){
  t.on('metadata',function(){
    log('bg metadata:',t.name);
    if(t.pieces&&t.pieces.length>0){try{t.critical(0,Math.max(0,Math.floor(t.pieces.length*0.05)-1));}catch(e){}}
    startHUD(t);
  });
  t.on('done',function(){transition('SEEDING');idbStoreTorrent(t);chat('Seeding "'+(t.name||dn)+'"');});
  t.on('wire',function(w){log('peer:',w.remoteAddress||'webrtc','total:',t.numPeers);});
  t.on('warning',function(w){warn('torrent:',w.message||w);});
  t.on('error',function(e){const m=e.message||String(e);if(m.indexOf('duplicate')>=0)return;warn('bg torrent:',m);});
}

function bindTorrent(t){
  t.on('infoHash',function(){
    log('infoHash:',t.infoHash);
    // Start metadata timeout — 45s is generous for slow peers
    // If metadata never arrives the user is stuck at ⟳ forever
    if(S.metadataTimer)clearTimeout(S.metadataTimer);
    S.metadataTimer=setTimeout(function(){
      S.metadataTimer=null;
      if(S.state!=='METADATA')return; // already moved on
      warn('metadata timeout for',t.infoHash);
      const msg='⚠ Metadata timeout — could not get torrent info from peers. '+
        'The swarm may be dead or all peers are behind strict NAT. '+
        'Try adding a webseed: !hs url <direct-mp4-url>';
      chat(msg);
      setOverlay('Metadata timeout\nNo peers served torrent info\nTry: !hs url <direct-mp4-url>');
      log('destroying stalled torrent');
      t.destroy(function(){});
      S.torrent=null;
      transition('IDLE');
      playlistAdvance(); // auto-advance playlist if queued
    },45000);
  });
  t.on('metadata',function(){
    // Cancel the metadata timeout — we got what we needed
    if(S.metadataTimer){clearTimeout(S.metadataTimer);S.metadataTimer=null;}
    log('metadata:',t.name,'files:',t.files.length);
    if(t.pieces&&t.pieces.length>0){try{t.critical(0,Math.max(0,Math.floor(t.pieces.length*0.05)-1));}catch(e){}}

    // Find best video file
    const PLAYABLE=/\.(mp4|webm|mkv|mov|ogv|ogg|m4v|avi)$/i;
    let best=null;
    t.files.forEach(function(f){
      if(!best){best=f;return;}
      if(PLAYABLE.test(f.name)&&!PLAYABLE.test(best.name)){best=f;return;}
      if(f.length>best.length)best=f;
    });

    // Codec check — catch HEVC/x265 and unsupported containers before attempting play
    if(best){
      const fname=best.name||t.name||'';
      if(filenameHasHevc(fname)){
        const msg='⚠ "'+fname+'" is HEVC/x265 — not playable in Chrome/Firefox/Brave. Seeding in background.';
        chat(msg);setOverlay('HEVC/x265 — unsupported codec\nSeeding in background ▲');
        log('codec block: HEVC in',fname);
        transition('SEEDING');startHUD(t);
        t.on('done',function(){idbStoreTorrent(t);});
        t.on('wire',function(w){log('peer:',w.remoteAddress||'webrtc','total:',t.numPeers);});
        return;
      }
      const cc=checkCodec(fname);
      if(!cc.playable){
        chat('⚠ "'+fname+'" — '+cc.reason+'. Seeding in background.');
        setOverlay(cc.reason+'\nSeeding in background ▲');
        log('codec block:',cc.reason);
        transition('SEEDING');startHUD(t);
        t.on('done',function(){idbStoreTorrent(t);});
        t.on('wire',function(w){log('peer:',w.remoteAddress||'webrtc','total:',t.numPeers);});
        return;
      }
    }

    const BLOB_LIMIT=200*1024*1024;
    const fileSize=best?best.length:0;
    const te=document.getElementById('currenttitle');if(te)te.textContent=t.name;

    // FIX: large file + no webseed — seed only, clear error message, no ghost PLAYING state
    if(fileSize>BLOB_LIMIT&&!S.activeWs){
      chat('⚠ "'+t.name+'" is '+Math.round(fileSize/1e6)+'MB — needs a webseed to play. Use: !hs url <direct-mp4-url>');
      setOverlay('No webseed for large file\nAdd: !hs url <direct-url>\nSeeding in background ▲');
      log('large file, no webseed — seed only');
      transition('SEEDING');startHUD(t);
      t.on('done',function(){idbStoreTorrent(t);});
      t.on('wire',function(w){log('peer:',w.remoteAddress||'webrtc','total:',t.numPeers);});
      return;
    }

    transition('BUFFERING');
    chat('"'+t.name+'" — buffering…');
    attachVideo(t,S.activeWs);
    startHUD(t);
    startSyncTimer();
  });
  t.on('ready',function(){if(S.state==='BUFFERING'){transition('PLAYING');chat('"'+t.name+'" ready — '+t.numPeers+'p');}});
  t.on('done',function(){transition('SEEDING');idbStoreTorrent(t);chat('Seeding "'+t.name+'"');});
  t.on('wire',function(w){log('peer:',w.remoteAddress||'webrtc','total:',t.numPeers);});
  t.on('warning',function(w){warn('torrent warn:',w.message||w);});
  t.on('error',function(e){
    if(S.metadataTimer){clearTimeout(S.metadataTimer);S.metadataTimer=null;}
    const msg=e.message||String(e);errlog('torrent error:',msg);
    if(msg.indexOf('duplicate')>=0&&t.infoHash){
      const ex=S.wt.get(t.infoHash);
      if(ex&&ex!==t){
        S.torrent=ex;
        if(ex.files&&ex.files.length){transition('BUFFERING');attachVideo(ex,S.activeWs);startHUD(ex);startSyncTimer();}
        else bindTorrent(ex);
        return;
      }
    }
    transition('IDLE');setOverlay('Error: '+msg);playlistAdvance();
  });
}

// ── VIDEO ─────────────────────────────────────────────────────
function attachVideo(t,wsUrl){
  if(S.videoAttached){log('already attached');return;}
  S.videoAttached=true;
  const ov=document.getElementById('hs-overlay');if(ov)ov.style.display='none';
  if(!t){if(wsUrl)httpFallback(wsUrl);else errlog('no torrent and no wsUrl');return;}

  const PLAYABLE=/\.(mp4|webm|mkv|mov|ogv|ogg|m4v)$/i;
  let best=null;
  t.files.forEach(function(f){
    if(!best){best=f;return;}
    if(PLAYABLE.test(f.name)&&!PLAYABLE.test(best.name)){best=f;return;}
    if(f.length>best.length)best=f;
  });
  if(!best){errlog('no playable file');if(wsUrl)httpFallback(wsUrl);return;}

  const BLOB_LIMIT=200*1024*1024;
  if(best.length>BLOB_LIMIT){
    log('file >200MB');if(wsUrl)httpFallback(wsUrl);
    else setOverlay('Large file, no webseed.\nAdd: !hs url <direct-url>');
    return;
  }

  setOverlay('P2P streaming…');
  var errorFired=false;
  S.video.onplaying=function(){S.playbackSource='P2P';setOverlay('');hideTapOverlay();if(S.renderToTimer){clearTimeout(S.renderToTimer);S.renderToTimer=null;}};
  S.video.oncanplay=function(){if(S.video.paused&&S.video.currentTime<0.5)showTapOverlay();};
  S.video.onended=function(){playlistAdvance();};
  S.video.onerror=function(){
    if(errorFired)return;errorFired=true;
    const msg=S.video.error?S.video.error.message:'unknown';
    errlog('P2P video error:',msg);
    if(S.renderToTimer){clearTimeout(S.renderToTimer);S.renderToTimer=null;}
    S.video.onerror=null;S.video.onplaying=null;S.video.oncanplay=null;
    S.video.removeAttribute('src');S.video.load();
    if(wsUrl)httpFallback(wsUrl);else{setOverlay('Playback failed.');transition('IDLE');}
  };
  best.renderTo(S.video,function(err){
    if(err){if(errorFired)return;errorFired=true;errlog('renderTo:',err.message);S.videoAttached=false;S.video.onerror=null;S.video.onplaying=null;S.video.oncanplay=null;if(wsUrl)httpFallback(wsUrl);return;}
    log('renderTo attached readyState='+S.video.readyState);
    if(S.renderToTimer)clearTimeout(S.renderToTimer);
    S.renderToTimer=setTimeout(function(){
      S.renderToTimer=null;if(errorFired)return;
      if(S.video.readyState<=1&&S.video.paused){
        warn('renderTo stalled — HTTP fallback');errorFired=true;
        S.video.onerror=null;S.video.onplaying=null;S.video.oncanplay=null;
        if(wsUrl)httpFallback(wsUrl);else{setOverlay('Cannot play format.');transition('IDLE');}
      }
    },8000);
  });
}

function httpFallback(wsUrl){
  try{S.playbackSource='HTTP:'+new URL(wsUrl).hostname;}catch(e){S.playbackSource='HTTP';}
  setOverlay('');
  var fallbacks=[];
  if(S.torrent&&S.torrent.infoHash){const k=KNOWN[S.torrent.infoHash];if(k&&k.wsFallbacks)fallbacks=k.wsFallbacks.slice();}
  playDirect(wsUrl,fallbacks);
}
function playDirect(url,fallbacks){
  S.errorHandled=false;wireVideoEvents(url,fallbacks||[]);
  S.video.src=url;S.video.load();
  const p=S.video.play();
  if(p&&typeof p.then==='function')p.then(function(){log('direct play started');}).catch(function(e){if(!S.errorHandled)showTapOverlay();});
}
function wireVideoEvents(currentUrl,fallbacks){
  S.video.onplaying=function(){
    if(currentUrl){try{S.playbackSource='HTTP:'+new URL(currentUrl).hostname.replace('www.','');}catch(e){S.playbackSource='HTTP';}}
    if(S.state==='BUFFERING'||S.state==='METADATA')transition('PLAYING');
    hideTapOverlay();
  };
  var cpd=null;
  S.video.oncanplay=function(){if(cpd)clearTimeout(cpd);cpd=setTimeout(function(){cpd=null;if(S.video&&S.video.paused&&S.video.readyState>=3)showTapOverlay();},800);};
  S.video.onended=function(){playlistAdvance();};
  S.video.onerror=function(){
    const err=S.video.error,msg=err?err.message:'unknown';
    errlog('video error code='+(err?err.code:0)+':',msg);
    S.errorHandled=true;
    if(fallbacks&&fallbacks.length>0){
      const next=fallbacks[0],rest=fallbacks.slice(1);
      warn('fallback:',next.slice(0,80));
      S.video.removeAttribute('src');S.video.load();S.errorHandled=false;
      wireVideoEvents(next,rest);S.video.src=next;S.video.load();
      S.video.play().catch(function(){showTapOverlay();});return;
    }
    S.video.removeAttribute('src');S.video.load();S.videoAttached=false;
    setOverlay('All URLs failed: '+msg);
    if(S.state!=='IDLE')transition('IDLE');
    playlistAdvance();
  };
}

function showTapOverlay(){
  if(document.getElementById('hs-tap'))return;
  const tap=document.createElement('div');tap.id='hs-tap';
  tap.style.cssText='position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;z-index:10;background:rgba(0,0,0,0.55);';
  tap.innerHTML='<div style="font-size:64px;line-height:1;text-shadow:0 0 30px #39ff14">▶</div><div style="color:#39ff14;font:13px Courier New,monospace;margin-top:8px">tap to play</div>';
  tap.onclick=function(){S.video.muted=true;S.video.play().catch(function(e){errlog('tap play:',e.message);});};
  const vw=document.getElementById('hs-vwrap');if(vw)vw.appendChild(tap);
}
function hideTapOverlay(){const el=document.getElementById('hs-tap');if(el)el.remove();}

// ── HUD ──────────────────────────────────────────────────────
function startHUD(t){
  if(S.hudTimer)clearInterval(S.hudTimer);
  S.hudTimer=setInterval(function(){
    const _t=S.torrent||t;if(!_t)return;
    const pct=_t.length?(_t.downloaded/_t.length*100).toFixed(1):'?';
    const spd=fmtSpd(_t.downloadSpeed)+'▼ '+fmtSpd(_t.uploadSpeed)+'▲';
    let rtc=0,wsp=0;
    if(_t.wires)_t.wires.forEach(function(w){if(w.type==='webSeed')wsp++;else rtc++;});
    const el=document.getElementById('hs-hud');
    if(el)el.textContent='['+(S.playbackSource||'P2P')+'] '+pct+'% · '+rtc+'🔗 '+wsp+'🌐 · '+spd;
  },2000);
}

// ── STOP ──────────────────────────────────────────────────────
function stopAll(announce){
  if(S.hudTimer){clearInterval(S.hudTimer);S.hudTimer=null;}
  if(S.syncTimer){clearInterval(S.syncTimer);S.syncTimer=null;}
  if(S.metadataTimer){clearTimeout(S.metadataTimer);S.metadataTimer=null;}
  if(S.torrent){S.torrent.destroy(function(){S.torrent=null;});}
  S.videoAttached=false;S.activeWs=null;S.errorHandled=false;S.playbackSource='P2P';
  if(S.renderToTimer){clearTimeout(S.renderToTimer);S.renderToTimer=null;}
  if(S.video){
    S.video.onplaying=null;S.video.oncanplay=null;S.video.onerror=null;S.video.onended=null;
    S.video.pause();S.video.removeAttribute('src');S.video.load();
  }
  transition('IDLE');
  setOverlay('Nothing Playing — search, paste URL, or !hs help');
  const hud=document.getElementById('hs-hud');if(hud)hud.textContent='';
  if(announce)chat('HiveStream stopped.');
}

// ── SYNC ──────────────────────────────────────────────────────
function startSyncTimer(){
  if(S.syncTimer)return;
  S.syncTimer=setInterval(function(){if(S.video&&!S.video.paused&&isCoordinator())relay('_s '+S.video.currentTime.toFixed(2));},CFG.syncMs);
}
function applySync(t){if(!S.video||isNaN(t))return;if(Math.abs(S.video.currentTime-t)>CFG.syncThres){log('sync seek:',t);S.video.currentTime=t;}}

// ── PEERS ─────────────────────────────────────────────────────
function cmdPeers(){
  if(!S.torrent){chat('No active torrent.');return;}
  const t=S.torrent;
  chat('Torrent: '+t.name+' | peers: '+(t.numPeers||0)+' | dl: '+Math.round(t.downloaded/1024)+'KB | ul: '+Math.round(t.uploaded/1024)+'KB');
  if(t.wires&&t.wires.length){
    t.wires.forEach(function(w,i){
      chat('['+i+'] '+(w.type||'?')+' '+(w.remoteAddress||w.id||'?').slice(0,30)+' '+fmtSpd(w.downloadSpeed?w.downloadSpeed():0)+'▼ '+fmtSpd(w.uploadSpeed?w.uploadSpeed():0)+'▲');
    });
  }else{chat('No wires connected yet.');}
}

// ── URL ───────────────────────────────────────────────────────
function cmdUrl(url){
  if(!isCoordinator()){chat('Only coordinator.');return;}
  if(S.state!=='IDLE'){chat('Already '+S.state+'. Stop first.');return;}
  url=url.trim();
  if(!url.startsWith('http')){chat('Need https:// URL');return;}
  const hash=hashFromUrl(url);
  const parts=url.split('/');
  const name=decodeURIComponent(parts[parts.length-1].split('?')[0])||'video';
  chat('Loading URL: '+name);
  log('cmdUrl hash='+hash+' url='+url.slice(0,80));
  startSwarmThenRelay(hash,url,name);
}

// ── PLAYLIST ──────────────────────────────────────────────────
function playlistAdd(item){
  S.playlist.push(item);renderPlaylistUI();
  chat('Queued ['+S.playlist.length+']: '+item.name);
  if(S.state==='IDLE')playlistAdvance();
}
function playlistAdvance(){
  if(!isCoordinator())return;if(!S.playlist.length)return;
  const next=S.playlistPos+1;
  if(next>=S.playlist.length){log('playlist exhausted');S.playlistPos=-1;chat('Playlist complete.');renderPlaylistUI();return;}
  S.playlistPos=next;renderPlaylistUI();
  const item=S.playlist[next];
  if(S.state!=='IDLE'){stopAll(false);setTimeout(function(){playlistPlay(item);},500);}
  else playlistPlay(item);
}
function playlistPlay(item){
  if(!item)return;chat('▶ Queue: '+item.name);
  if(item.type==='magnet')cmdMagnet(item.value);
  else if(item.type==='hash')cmdPickHash(item.value);
  else if(item.type==='pt')cmdPt(item.value);
  else if(item.type==='url')cmdUrl(item.value);
  else if(item.type==='archive')archivePick({identifier:item.value,name:item.name});
}
function playlistClear(){S.playlist=[];S.playlistPos=-1;renderPlaylistUI();chat('Playlist cleared.');}
function playlistShow(){
  if(!S.playlist.length){chat('Playlist empty.');return;}
  S.playlist.forEach(function(it,i){chat((i===S.playlistPos?'▶ ':i<S.playlistPos?'✓ ':'  ')+(i+1)+'. '+it.name);});
}
function renderPlaylistUI(){
  const list=document.getElementById('hs-playlist-items');if(!list)return;
  list.innerHTML='';
  const titleEl=document.getElementById('hs-pl-title');
  const body=document.getElementById('hs-playlist-body');
  const isOpen=body&&body.classList.contains('open');
  if(titleEl)titleEl.textContent=(isOpen?'▾':'▸')+' queue ('+S.playlist.length+')';
  if(!S.playlist.length){list.innerHTML='<div style="color:#333;font:10px Courier New,monospace;padding:4px 6px">queue empty</div>';return;}
  S.playlist.forEach(function(item,i){
    const playing=i===S.playlistPos,played=i<S.playlistPos;
    const div=document.createElement('div');
    div.style.cssText='display:flex;align-items:center;gap:6px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #111;'+(playing?'background:#0a1a0a;color:#39ff14;':played?'color:#333;':'color:#888;');
    div.innerHTML='<span style="font-size:10px;width:14px;text-align:center">'+(playing?'▶':played?'✓':i+1)+'</span>'+
      '<span style="flex:1;font:10px Courier New,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escHtml(item.name)+'</span>'+
      '<button style="background:none;border:none;color:#ff3939;cursor:pointer;font-size:10px;padding:0 4px" data-i="'+i+'">✕</button>';
    div.querySelector('button').onclick=function(e){
      e.stopPropagation();const idx=parseInt(this.getAttribute('data-i'));
      S.playlist.splice(idx,1);if(S.playlistPos>idx)S.playlistPos--;renderPlaylistUI();
    };
    div.onclick=function(){if(i===S.playlistPos)return;S.playlistPos=i-1;playlistAdvance();};
    list.appendChild(div);
  });
}
function cmdAdd(raw){
  if(!raw){chat('Usage: !hs add <magnet|hash|url>');return;}
  raw=raw.trim();
  if(raw.startsWith('magnet:')){
    const hm=raw.match(/urn:btih:([0-9a-f]{40})/i);
    const dm=raw.match(/[?&]dn=([^&]+)/);
    if(!hm){chat('Could not parse magnet hash');return;}
    const dn=dm?decodeURIComponent(dm[1].replace(/\+/g,' ')):null;
    playlistAdd({type:'magnet',value:raw,name:dn||hm[1].slice(0,8)+'…'});return;
  }
  if(/^[0-9a-f]{40}$/i.test(raw)){
    const h=raw.toLowerCase();
    playlistAdd({type:'hash',value:h,name:KNOWN[h]?KNOWN[h].name:h.slice(0,8)+'…'});return;
  }
  if(raw.startsWith('http')){
    try{const u=new URL(raw);const m=u.pathname.match(/\/(?:videos\/watch|w)\/([^/?#]+)/);if(m){playlistAdd({type:'pt',value:raw,name:u.hostname+'/'+m[1]});return;}}catch(e){}
    const parts=raw.split('/');
    playlistAdd({type:'url',value:raw,name:decodeURIComponent(parts[parts.length-1].split('?')[0])||'video'});return;
  }
  chat('Unrecognised format.');
}

// ── TRACKERS ──────────────────────────────────────────────────
function cmdTrackers(){
  chat('Pinging '+CFG.trackers.length+' trackers…');
  const panel=document.getElementById('hs-tracker-panel');if(panel)panel.style.display='block';
  let done=0;const ok={n:0};
  CFG.trackers.forEach(function(url){
    const key=url.replace('wss://','').replace('/announce','').replace('/tracker/socket','');
    const sk=key.replace(/[^a-z0-9]/gi,'_');
    updateTrackerUI(sk,'…','#555');
    let ws;
    const timer=setTimeout(function(){updateTrackerUI(sk,'timeout','#ff9939');if(++done===CFG.trackers.length)chat('Trackers: '+ok.n+'/'+done+' ok');},5000);
    try{
      ws=new WebSocket(url);
      ws.onopen=function(){clearTimeout(timer);ok.n++;updateTrackerUI(sk,'✓ ok','#39ff14');ws.close();if(++done===CFG.trackers.length)chat('Trackers: '+ok.n+'/'+done+' ok');};
      ws.onerror=function(){clearTimeout(timer);updateTrackerUI(sk,'error','#ff3939');if(++done===CFG.trackers.length)chat('Trackers: '+ok.n+'/'+done+' ok');};
    }catch(e){clearTimeout(timer);updateTrackerUI(sk,'fail','#ff3939');if(++done===CFG.trackers.length)chat('Trackers: '+ok.n+'/'+done+' ok');}
  });
}
function updateTrackerUI(sk,status,color){const el=document.getElementById('hs-tr-'+sk);if(el){el.textContent=status;el.style.color=color;}}

// ── SEARCH ────────────────────────────────────────────────────
function cmdArchive(q){
  if(!isCoordinator()){chat('Only coordinator.');return;}if(S.state!=='IDLE'){chat('Stop first.');return;}
  transition('FETCHING');setOverlay('Searching Archive.org…');
  fetch(CFG.archiveApi+'?q='+encodeURIComponent(q+' AND mediatype:movies')+'&fl[]=identifier,title&sort[]=downloads+desc&rows=20&output=json')
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
    .then(function(d){
      transition('IDLE');
      const docs=(d.response&&d.response.docs)||[];
      if(!docs.length){chat('No results for: '+q);setOverlay('Nothing Playing');return;}
      S.results=docs.map(function(doc){return{_archive:true,identifier:doc.identifier,name:doc.title||doc.identifier,duration:0,account:{host:'archive.org'}};});
      showGrid(S.results);S.results.slice(0,8).forEach(function(v,i){chat((i+1)+'. '+v.name);});
    })
    .catch(function(e){transition('IDLE');setOverlay('Nothing Playing');chat('Archive error: '+e.message);});
}

// FIX: removed stray transition('PLAYING') — onplaying handler sets PLAYING
function archivePick(item){
  transition('FETCHING');setOverlay('Fetching Archive.org…');
  fetch('https://archive.org/metadata/'+item.identifier)
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
    .then(function(meta){
      transition('IDLE');
      const all=(meta.files||[]).filter(function(f){return/\.mp4$/i.test(f.name);});
      const orig=all.filter(function(f){return f.source!=='derivative';});
      const target=orig[0]||all[0];
      if(!target){chat('No MP4 in: '+item.identifier);setOverlay('Nothing Playing');return;}
      const url='https://archive.org/download/'+item.identifier+'/'+target.name;
      chat('Playing: "'+item.name+'"');
      S.activeWs=url;transition('BUFFERING');
      playDirect(url,[]);
      const te=document.getElementById('currenttitle');if(te)te.textContent=item.name;
    })
    .catch(function(e){transition('IDLE');setOverlay('Nothing Playing');chat('Archive error: '+e.message);});
}

function cmdTop(){
  if(!isCoordinator()){chat('Only coordinator.');return;}if(S.state!=='IDLE'){chat('Stop first.');return;}
  transition('FETCHING');setOverlay('Fetching trending…');
  fetch(CFG.topApi)
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
    .then(function(d){
      transition('IDLE');S.results=d.data||[];
      if(!S.results.length){chat('No results.');setOverlay('Nothing Playing');return;}
      showGrid(S.results);S.results.slice(0,8).forEach(function(v,i){chat((i+1)+'. ['+fmtDur(v.duration)+'] '+v.name);});
    })
    .catch(function(e){transition('IDLE');setOverlay('Nothing Playing');chat('Top error: '+e.message);});
}
function cmdSearch(q){
  if(!isCoordinator()){chat('Only coordinator.');return;}if(S.state!=='IDLE'){chat('Stop first.');return;}
  if(q.toLowerCase().startsWith('archive:')){cmdArchive(q.slice(8).trim());return;}
  transition('FETCHING');setOverlay('Searching…');
  fetch(CFG.searchApi+'?search='+encodeURIComponent(q)+'&count=40&sort=-views&nsfw=false')
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
    .then(function(d){
      transition('IDLE');
      const all=d.data||[];
      S.results=all.filter(function(v){const h=v.account&&v.account.host||'';return!CFG.corsBlocklist.includes(h);});
      if(!S.results.length){chat('No results for: '+q+' (try !hs search archive:'+q+')');setOverlay('Nothing Playing');return;}
      showGrid(S.results);S.results.slice(0,8).forEach(function(v,i){chat((i+1)+'. ['+fmtDur(v.duration)+'] '+v.name+' ('+(v.account&&v.account.host||'?')+')');});
    })
    .catch(function(e){transition('IDLE');setOverlay('Nothing Playing');chat('Search error: '+e.message);});
}
function cmdPick(n){
  if(!isCoordinator()){chat('Only coordinator.');return;}if(S.state!=='IDLE'){chat('Already '+S.state+'. Stop first.');return;}
  const v=S.results[n-1];if(!v){chat('No result '+n+'.');return;}
  if(v._archive){archivePick(v);return;}
  const host=v.account&&v.account.host?'https://'+v.account.host:'https://framatube.org';
  const uuid=v.uuid||v.id||v.shortUUID;if(!uuid){chat('No video ID in result '+n);return;}
  transition('FETCHING');setOverlay('Fetching video info…');
  fetch(host+'/api/v1/videos/'+uuid)
    .then(function(r){if(!r.ok)throw new Error('API '+r.status);return r.json();})
    .then(function(data){
      const files=(data.files||[]).filter(function(f){return(f.magnetUri||f.fileUrl)&&!/-hls\./i.test(f.torrentUrl||'');});
      if(!files.length){transition('IDLE');setOverlay('Nothing Playing');chat('⚠ "'+data.name+'" HLS-only.');return;}
      const sorted=files.slice().sort(function(a,b){return parseInt((b.resolution&&(b.resolution.id||b.resolution.label))||0)-parseInt((a.resolution&&(a.resolution.id||a.resolution.label))||0);});
      const target=sorted.find(function(f){return parseInt((f.resolution&&(f.resolution.id||f.resolution.label))||0)<=720;})||sorted[sorted.length-1];
      const ws=target.fileUrl||null,mag=target.magnetUri||null;
      let hash=null;if(mag){const m=mag.match(/urn:btih:([0-9a-f]{40})/i);if(m)hash=m[1].toLowerCase();}
      if(!hash){transition('IDLE');setOverlay('Nothing Playing');chat('No hash for: '+data.name);return;}
      chat('Playing: "'+data.name+'"');setOverlay('Connecting…');transition('IDLE');
      startSwarmThenRelay(hash,ws||null,data.name);
    })
    .catch(function(e){transition('IDLE');setOverlay('Nothing Playing');chat('Pick error: '+e.message);});
}
function cmdMagnet(magnet){
  magnet=(magnet||'').trim();
  if(!magnet.startsWith('magnet:')){const idx=magnet.indexOf('magnet:');if(idx>=0)magnet=magnet.slice(idx);}
  if(!magnet.startsWith('magnet:')){chat('Usage: !hs magnet <magnet-uri>');return;}
  let hash=null,dn=null,ws=null;
  try{
    const u=new URL(magnet);
    u.searchParams.getAll('xt').forEach(function(v){const m=v.match(/urn:btih:([0-9a-f]{40})/i);if(m)hash=m[1].toLowerCase();});
    dn=u.searchParams.get('dn')||null;ws=u.searchParams.get('ws')||null;
  }catch(e){
    const hm=magnet.match(/urn:btih:([0-9a-f]{40})/i);if(hm)hash=hm[1].toLowerCase();
    const dm=magnet.match(/[?&]dn=([^&]+)/);if(dm){try{dn=decodeURIComponent(dm[1].replace(/\+/g,' '));}catch(e2){dn=dm[1];}}
    const wm=magnet.match(/[?&]ws=([^&]+)/);if(wm){try{ws=decodeURIComponent(wm[1]);}catch(e2){ws=wm[1];}}
  }
  if(!hash){chat('Could not extract hash from magnet');return;}
  if(!isCoordinator()){chat('Only coordinator.');return;}
  if(S.state!=='IDLE'){chat('Already '+S.state+'. Stop first.');return;}
  chat('Loading: '+(dn||hash.slice(0,8)+'…')+' [magnet]');
  startSwarmThenRelay(hash,ws,dn||hash.slice(0,8)+'…');
}
function cmdPt(url){
  let origin,vid;
  try{const u=new URL(url);origin=u.origin;const m=u.pathname.match(/\/(?:videos\/watch|w)\/([^/?#]+)/);if(!m)throw new Error('Bad PT URL');vid=m[1];}
  catch(e){chat('PT error: '+e.message);return;}
  transition('FETCHING');setOverlay('Fetching PeerTube…');
  fetch(origin+'/api/v1/videos/'+vid)
    .then(function(r){if(!r.ok)throw new Error('API '+r.status);return r.json();})
    .then(function(data){
      const files=(data.files||[]).filter(function(f){return(f.magnetUri||f.fileUrl)&&!/-hls\./i.test(f.torrentUrl||'');});
      if(!files.length){transition('IDLE');setOverlay('Nothing Playing');chat('⚠ HLS-only.');return;}
      const sorted=files.slice().sort(function(a,b){return parseInt((b.resolution&&(b.resolution.id||b.resolution.label))||0)-parseInt((a.resolution&&(a.resolution.id||a.resolution.label))||0);});
      const target=sorted.find(function(f){return parseInt((f.resolution&&(f.resolution.id||f.resolution.label))||0)<=720;})||sorted[sorted.length-1];
      const ws=target.fileUrl||null,mag=target.magnetUri||null;
      let hash=null;if(mag){const m=mag.match(/urn:btih:([0-9a-f]{40})/i);if(m)hash=m[1].toLowerCase();}
      if(!hash){transition('IDLE');setOverlay('Nothing Playing');chat('No hash: '+data.name);return;}
      chat('Playing: "'+data.name+'"');setOverlay('Connecting…');transition('IDLE');
      startSwarmThenRelay(hash,ws,data.name);
    })
    .catch(function(e){transition('IDLE');setOverlay('Nothing Playing');chat('PT error: '+e.message);});
}
function cmdPickHash(hash){
  if(!isCoordinator()){chat('Only coordinator.');return;}if(S.state!=='IDLE'){chat('Stop first.');return;}
  const k=KNOWN[hash],ws=k?k.ws:null,name=k?k.name:hash.slice(0,8)+'…';
  chat('Loading: '+name);
  if(k&&k.torrentUrl){
    transition('METADATA');setOverlay('Loading…');if(!S.wt)S.wt=mkClient();
    const ex=S.wt.get(hash);
    if(ex){
      S.torrent=ex;S.activeWs=ws||null;
      if(ws)relay(encodeRelay(hash,ws));else relay('_i '+hash+' -');
      if(ex.files&&ex.files.length){transition('BUFFERING');attachVideo(ex,ws);startHUD(ex);startSyncTimer();}
      else bindTorrent(ex);return;
    }
    let t;
    try{t=S.wt.add(k.torrentUrl,{announce:CFG.trackers});}
    catch(e){try{t=S.wt.add(buildMagnet(hash,ws,name));}catch(e2){t=S.wt.get(hash);if(!t){errlog('all add failed');transition('IDLE');return;}}}
    S.torrent=t;S.activeWs=ws||null;
    const doRelay=function(){if(ws)relay(encodeRelay(hash,ws));else relay('_i '+hash+' -');};
    if(t.infoHash)doRelay();else t.once('infoHash',doRelay);
    bindTorrent(t);
  }else{
    startSwarm(hash,ws,name);
    if(ws)relay(encodeRelay(hash,ws));else relay('_i '+hash+' -');
  }
}

// ── UI ────────────────────────────────────────────────────────
function buildUI(){
  if(document.getElementById('hs-root'))return;
  const style=document.createElement('style');
  style.textContent=[
    '#hs-root{width:100%;background:#080808;border:1px solid #1a1a1a;font-family:"Courier New",Courier,monospace;box-sizing:border-box;margin-bottom:6px;}',
    '#hs-toolbar{display:flex;align-items:center;gap:5px;padding:5px 8px;background:#0d0d0d;border-bottom:1px solid #1a1a1a;flex-wrap:wrap;}',
    '#hs-toolbar input{flex:1;min-width:120px;padding:3px 7px;background:#000;color:#39ff14;border:1px solid #1c1c1c;outline:none;font:11px "Courier New",monospace;}',
    '#hs-toolbar input::placeholder{color:#2a2a2a;}',
    '#hs-toolbar input:focus{border-color:#39ff14;}',
    '.hs-btn{padding:3px 8px;background:#000;color:#39ff14;border:1px solid #1c1c1c;cursor:pointer;font:10px "Courier New",monospace;white-space:nowrap;transition:all .15s;}',
    '.hs-btn:hover{background:#39ff14;color:#000;}',
    '.hs-btn.danger{color:#ff3939;}.hs-btn.danger:hover{background:#ff3939;color:#000;}',
    '#hs-state{font:10px "Courier New",monospace;padding:2px 6px;border:1px solid #1c1c1c;color:#555;margin-left:auto;white-space:nowrap;}',
    '.hs-state-playing{color:#39ff14!important;border-color:#39ff14!important;}',
    '.hs-state-seeding{color:#39f!important;border-color:#39f!important;}',
    '.hs-state-buffering,.hs-state-metadata{color:#ff9939!important;border-color:#ff9939!important;}',
    '#hs-grid{display:flex;overflow-x:auto;gap:4px;padding:5px;background:#050505;scrollbar-width:thin;}',
    '#hs-grid:empty{display:none;}',
    '.hs-thumb{cursor:pointer;flex-shrink:0;width:110px;border:1px solid #111;background:#0a0a0a;}',
    '.hs-thumb:hover{border-color:#39ff14;}',
    '.hs-thumb img{width:110px;height:62px;object-fit:cover;display:block;background:#111;}',
    '.hs-tlabel{color:#888;font:9px "Courier New",monospace;padding:2px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.hs-tdur{color:#333;font:9px "Courier New",monospace;padding:0 3px 2px;}',
    '#hs-vwrap{position:relative;background:#000;width:100%;}',
    '#hs-video{width:100%;display:block;min-height:240px;background:#000;pointer-events:none;}',
    '#hs-hud{position:absolute;top:4px;left:4px;background:rgba(0,0,0,.85);color:#39ff14;font:9px "Courier New",monospace;padding:2px 5px;pointer-events:none;border:1px solid #1a1a1a;z-index:5;}',
    '#hs-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#2a2a2a;font:11px "Courier New",monospace;pointer-events:none;z-index:4;text-align:center;padding:8px;white-space:pre-line;}',
    '#hs-controls{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#0d0d0d;border-top:1px solid #1a1a1a;}',
    '#hs-controls button{background:none;border:none;color:#39ff14;cursor:pointer;font-size:14px;padding:1px 5px;line-height:1;}',
    '#hs-controls button:hover{color:#fff;}',
    '#hs-seek{flex:1;height:3px;accent-color:#39ff14;cursor:pointer;background:#1a1a1a;border-radius:2px;}',
    '#hs-time{color:#444;font:10px "Courier New",monospace;white-space:nowrap;}',
    '#hs-playlist{background:#060606;border-top:1px solid #111;}',
    '#hs-playlist-header{display:flex;align-items:center;gap:5px;padding:3px 8px;cursor:pointer;border-bottom:1px solid #111;background:#0a0a0a;}',
    '#hs-playlist-header>span{color:#444;font:10px "Courier New",monospace;flex:1;}',
    '#hs-playlist-body{display:none;max-height:140px;overflow-y:auto;scrollbar-width:thin;}',
    '#hs-playlist-body.open{display:block;}',
    '#hs-pl-input-row{display:flex;gap:4px;padding:3px 6px;border-top:1px solid #111;background:#050505;}',
    '#hs-pl-input{flex:1;background:#000;color:#39ff14;border:1px solid #1c1c1c;font:10px "Courier New",monospace;padding:3px 5px;outline:none;}',
    '#hs-tracker-panel{display:none;background:#040404;border-top:1px solid #111;padding:5px 8px;max-height:160px;overflow-y:auto;}',
    '#hs-tracker-panel h4{color:#333;font:10px "Courier New",monospace;margin:0 0 3px;}',
    '.hs-tr-row{display:flex;justify-content:space-between;font:9px "Courier New",monospace;padding:1px 0;border-bottom:1px solid #0a0a0a;}',
    '.hs-tr-name{color:#2a2a2a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:82%;}',
    '#hs-debug{position:fixed;bottom:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,.97);border-top:1px solid #1a1a1a;display:none;flex-direction:column;}',
    '#hs-dbtop{display:flex;align-items:center;gap:5px;padding:3px 8px;background:#050505;border-bottom:1px solid #111;}',
    '#hs-dbtop span{color:#2a2a2a;font:10px "Courier New",monospace;flex:1;}',
    '#hs-dblog{color:#39ff14;font:9px "Courier New",monospace;padding:5px 8px;height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;scrollbar-width:thin;}',
    '#hs-dbtoggle{position:fixed;bottom:4px;right:60px;z-index:100000;background:#000;border:1px solid #1a1a1a;color:#333;font:9px "Courier New",monospace;padding:3px 8px;cursor:pointer;border-radius:2px;}',
    '#hs-dbtoggle:hover{border-color:#39ff14;color:#39ff14;}',
  ].join('');
  document.head.appendChild(style);

  const root=document.createElement('div');
  root.id='hs-root';

  // Build toolbar
  const tb=document.createElement('div');tb.id='hs-toolbar';
  tb.innerHTML='<input id="hs-sinput" placeholder="search, paste magnet or https://…">'+
    '<button class="hs-btn" id="hs-sbtn">search</button>'+
    '<button class="hs-btn" id="hs-topbtn">top</button>'+
    '<button class="hs-btn" id="hs-trkbtn">trackers</button>'+
    '<button class="hs-btn danger" id="hs-stopbtn">stop</button>'+
    '<span id="hs-state" class="hs-state">○ idle</span>';
  root.appendChild(tb);

  // Grid
  const grid=document.createElement('div');grid.id='hs-grid';root.appendChild(grid);

  // Video wrapper
  const vwrap=document.createElement('div');vwrap.id='hs-vwrap';
  const vid=document.createElement('video');vid.id='hs-video';vid.autoplay=true;vid.playsInline=true;vid.controls=false;
  S.video=vid;vwrap.appendChild(vid);
  const hud=document.createElement('div');hud.id='hs-hud';vwrap.appendChild(hud);
  const ov=document.createElement('div');ov.id='hs-overlay';ov.textContent='Nothing Playing — search, paste URL, or !hs help';vwrap.appendChild(ov);
  root.appendChild(vwrap);

  // Controls
  const ctrl=document.createElement('div');ctrl.id='hs-controls';
  ctrl.innerHTML='<button id="hs-playbtn">▶</button>'+
    '<input id="hs-seek" type="range" min="0" max="1000" value="0" step="1">'+
    '<span id="hs-time">0:00 / 0:00</span>'+
    '<button id="hs-syncbtn" style="font-size:10px">sync</button>'+
    '<button id="hs-peerbtn" style="font-size:10px">peers</button>'+
    '<button id="hs-mutebtn">🔊</button>'+
    '<button id="hs-fullbtn">⛶</button>';
  root.appendChild(ctrl);

  // Tracker panel
  const tp=document.createElement('div');tp.id='hs-tracker-panel';
  const tph=document.createElement('h4');tph.textContent='WSS Tracker Status';tp.appendChild(tph);
  CFG.trackers.forEach(function(url){
    const key=url.replace('wss://','').replace('/announce','').replace('/tracker/socket','');
    const sk=key.replace(/[^a-z0-9]/gi,'_');
    const row=document.createElement('div');row.className='hs-tr-row';
    row.innerHTML='<span class="hs-tr-name">'+escHtml(key)+'</span><span id="hs-tr-'+sk+'" style="color:#333">—</span>';
    tp.appendChild(row);
  });
  root.appendChild(tp);

  // Playlist
  const pl=document.createElement('div');pl.id='hs-playlist';
  pl.innerHTML='<div id="hs-playlist-header"><span id="hs-pl-title">▸ queue (0)</span>'+
    '<button class="hs-btn" id="hs-pl-next" style="font-size:9px">next ▶</button>'+
    '<button class="hs-btn danger" id="hs-pl-clear" style="font-size:9px">clear</button></div>'+
    '<div id="hs-playlist-body">'+
    '<div id="hs-playlist-items"><div style="color:#333;font:10px Courier New,monospace;padding:4px 6px">queue empty</div></div>'+
    '<div id="hs-pl-input-row"><input id="hs-pl-input" placeholder="magnet: or https://…">'+
    '<button class="hs-btn" id="hs-pl-addbtn">+ add</button></div></div>';
  root.appendChild(pl);

  // Inject into CyTube DOM — try anchors in order
  const anchors=['#videowrap','#leftpane','#main-col','#wrap'];
  let injected=false;
  for(let i=0;i<anchors.length;i++){
    const el=document.querySelector(anchors[i]);
    if(el){el.insertBefore(root,el.firstChild);log('UI injected into',anchors[i]);injected=true;break;}
  }
  if(!injected){document.body.insertBefore(root,document.body.firstChild);log('UI injected into body');}

  // Wire events
  document.getElementById('hs-sbtn').onclick=function(){
    const v=document.getElementById('hs-sinput').value.trim();if(!v)return;
    if(v.startsWith('magnet:')){cmdMagnet(v);document.getElementById('hs-sinput').value='';}
    else if(/^[0-9a-f]{40}$/i.test(v)){cmdPickHash(v.toLowerCase());document.getElementById('hs-sinput').value='';}
    else if(v.startsWith('http')){cmdUrl(v);document.getElementById('hs-sinput').value='';}
    else cmdSearch(v);
  };
  document.getElementById('hs-sinput').onkeydown=function(e){if(e.key==='Enter')document.getElementById('hs-sbtn').onclick();};
  document.getElementById('hs-topbtn').onclick=cmdTop;
  document.getElementById('hs-stopbtn').onclick=function(){stopAll(true);};
  document.getElementById('hs-trkbtn').onclick=cmdTrackers;
  document.getElementById('hs-peerbtn').onclick=cmdPeers;
  document.getElementById('hs-playbtn').onclick=function(){if(!S.video)return;S.video.paused?S.video.play().catch(function(){}):S.video.pause();};
  document.getElementById('hs-seek').oninput=function(){if(S.video&&S.video.duration)S.video.currentTime=(this.value/1000)*S.video.duration;};
  document.getElementById('hs-mutebtn').onclick=function(){if(!S.video)return;S.video.muted=!S.video.muted;this.textContent=S.video.muted?'🔇':'🔊';};
  document.getElementById('hs-syncbtn').onclick=function(){
    if(!S.video||!S.video.duration){chat('Nothing to sync.');return;}
    relay('_s '+S.video.currentTime.toFixed(2));
    const b=document.getElementById('hs-syncbtn');if(b){b.textContent='✓';setTimeout(function(){b.textContent='sync';},2000);}
  };
  document.getElementById('hs-fullbtn').onclick=function(){
    const vw=document.getElementById('hs-vwrap');if(!vw)return;
    document.fullscreenElement?document.exitFullscreen():(vw.requestFullscreen||vw.webkitRequestFullscreen||function(){}).call(vw);
  };
  document.getElementById('hs-playlist-header').onclick=function(e){
    if(e.target.tagName==='BUTTON')return;
    document.getElementById('hs-playlist-body').classList.toggle('open');renderPlaylistUI();
  };
  document.getElementById('hs-pl-next').onclick=function(){playlistAdvance();};
  document.getElementById('hs-pl-clear').onclick=function(){playlistClear();};
  document.getElementById('hs-pl-addbtn').onclick=function(){const inp=document.getElementById('hs-pl-input'),v=inp.value.trim();if(v){cmdAdd(v);inp.value='';}};
  document.getElementById('hs-pl-input').onkeydown=function(e){if(e.key==='Enter'){const v=this.value.trim();if(v){cmdAdd(v);this.value='';}};};

  // HUD tick
  setInterval(function(){
    if(!S.video)return;const v=S.video;
    const seek=document.getElementById('hs-seek'),time=document.getElementById('hs-time');
    const play=document.getElementById('hs-playbtn'),mute=document.getElementById('hs-mutebtn');
    if(seek&&!seek.matches(':active')&&v.duration)seek.value=Math.round((v.currentTime/v.duration)*1000);
    if(time&&v.duration)time.textContent=fmtDur(v.currentTime)+' / '+fmtDur(v.duration);
    if(play)play.textContent=v.paused?'▶':'⏸';
    if(mute)mute.textContent=v.muted?'🔇':'🔊';
  },500);

  buildDebugPanel();
  log('UI built v'+V);
}

function buildDebugPanel(){
  const panel=document.createElement('div');panel.id='hs-debug';
  panel.innerHTML='<div id="hs-dbtop"><span>hivestream '+V+'</span>'+
    '<button class="hs-btn" id="hs-dbcopy">copy</button>'+
    '<button class="hs-btn" id="hs-dbclear">clear</button>'+
    '<button class="hs-btn" id="hs-dbstatus">status</button>'+
    '<button class="hs-btn" id="hs-dbclose">✕</button></div>'+
    '<pre id="hs-dblog"></pre>';
  document.body.appendChild(panel);
  const toggle=document.createElement('button');toggle.id='hs-dbtoggle';toggle.textContent='HS debug';
  document.body.appendChild(toggle);
  toggle.onclick=function(){const p=document.getElementById('hs-debug');p.style.display=p.style.display==='flex'?'none':'flex';};
  document.getElementById('hs-dbclose').onclick=function(){document.getElementById('hs-debug').style.display='none';};
  document.getElementById('hs-dbclear').onclick=function(){dbLines.length=0;const el=document.getElementById('hs-dblog');if(el)el.textContent='';};
  document.getElementById('hs-dbcopy').onclick=function(){
    const txt=dbLines.join('\n'),btn=document.getElementById('hs-dbcopy');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(function(){btn.textContent='✓';setTimeout(function(){btn.textContent='copy';},1500)}).catch(function(){fbCopy(txt,btn);});
    }else fbCopy(txt,btn);
  };
  document.getElementById('hs-dbstatus').onclick=dumpStatus;
}
function fbCopy(txt,btn){
  const ta=document.createElement('textarea');ta.value=txt;ta.style.cssText='position:fixed;opacity:0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');btn.textContent='✓';setTimeout(function(){btn.textContent='copy';},1500);}catch(e){}
  document.body.removeChild(ta);
}
function dumpStatus(){
  log('── STATUS v'+V+' ──');
  log('state:',S.state,'| name:',S.myName,'| rank:',S.myRank,'| coord:',isCoordinator());
  log('WT:',typeof WebTorrent,'| client:',S.wt?'ok':'null');
  if(S.torrent){
    const t=S.torrent;
    log('torrent:',t.name,'| peers:',t.numPeers,'| dl:',Math.round(t.downloaded/1024)+'KB','| ul:',Math.round(t.uploaded/1024)+'KB');
    if(t.wires&&t.wires.length){
      t.wires.forEach(function(w,i){log('  wire['+i+']:',w.type||'?',w.remoteAddress||w.id||'?','dl:',fmtSpd(w.downloadSpeed?w.downloadSpeed():0),'ul:',fmtSpd(w.uploadSpeed?w.uploadSpeed():0));});
    }else log('  no wires');
  }else log('torrent: null');
  log('video readyState:',S.video?S.video.readyState:'none');
  log('playlist:',S.playlist.length,'items | pos:',S.playlistPos);
  log('idb:',S.idb?'open':'closed');
}

// ── UTILS ────────────────────────────────────────────────────
function showGrid(items){
  const grid=document.getElementById('hs-grid');if(!grid)return;
  grid.innerHTML='';
  items.forEach(function(r,i){
    const div=document.createElement('div');div.className='hs-thumb';
    const img=document.createElement('img');
    const hf=r.account&&r.account.host?'https://'+r.account.host:'';
    img.src=r.thumbnailUrl||(r.thumbnailPath?hf+r.thumbnailPath:'');
    img.onerror=function(){this.style.display='none';};
    const lbl=document.createElement('div');lbl.className='hs-tlabel';lbl.textContent=(i+1)+'. '+(r.name||'video');lbl.title=r.name||'';
    const dur=document.createElement('div');dur.className='hs-tdur';
    const host=r.account&&r.account.host||'';
    dur.textContent=fmtDur(r.duration)+(host?' · '+host:'')+(!r._archive&&!WEBTORRENT_INSTANCES.includes(host)&&host?' ⚠':'');
    div.appendChild(img);div.appendChild(lbl);div.appendChild(dur);
    div.onclick=function(){cmdPick(i+1);};
    grid.appendChild(div);
  });
}
function setOverlay(txt){const el=document.getElementById('hs-overlay');if(!el)return;el.style.display=txt?'flex':'none';el.textContent=txt;}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtDur(s){if(!s||isNaN(s))return'?';return Math.floor(s/60)+':'+(Math.floor(s%60)<10?'0':'')+Math.floor(s%60);}
function fmtSpd(b){if(b>1e6)return(b/1e6).toFixed(1)+'MB/s';if(b>1e3)return(b/1e3).toFixed(0)+'KB/s';return(b||0)+'B/s';}

// ── IDB ───────────────────────────────────────────────────────
function openIDB(){
  if(!window.indexedDB)return;
  const r=indexedDB.open(CFG.idbName,CFG.idbVersion);
  r.onupgradeneeded=function(e){
    const db=e.target.result;
    if(db.objectStoreNames.contains('torrents'))db.deleteObjectStore('torrents');
    if(db.objectStoreNames.contains('meta'))db.deleteObjectStore('meta');
    db.createObjectStore('torrents');db.createObjectStore('meta');
  };
  r.onsuccess=function(e){S.idb=e.target.result;log('IDB open');autoSeedFromIDB();};
  r.onerror=function(e){warn('IDB error:',e.target.error);};
}
function idbStoreTorrent(t){
  if(!S.idb)return;
  function tryStore(n){
    if(!t.torrentFile){if(n>0){setTimeout(function(){tryStore(n-1);},500);}return;}
    try{
      const b=t.torrentFile;
      const clean=b.byteOffset!==undefined?b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength):b.buffer||b;
      if(!clean||clean.byteLength<20)return;
      S.idb.transaction('torrents','readwrite').objectStore('torrents').put(clean,t.infoHash);
      log('IDB stored:',t.infoHash);
    }catch(e){warn('IDB store:',e.message);}
  }
  tryStore(6);
}
function idbGetTorrent(hash,cb){
  if(!S.idb){cb(null);return;}
  try{const req=S.idb.transaction('torrents','readonly').objectStore('torrents').get(hash);req.onsuccess=function(){cb(req.result||null);};req.onerror=function(){cb(null);};}catch(e){cb(null);}
}
function autoSeedFromIDB(){
  if(!S.idb)return;
  try{
    const req=S.idb.transaction('torrents','readonly').objectStore('torrents').getAllKeys();
    req.onsuccess=function(){
      const hashes=req.result||[];log('IDB cache:',hashes.length,'torrents');
      hashes.forEach(function(hash){
        idbGetTorrent(hash,function(buf){
          if(!buf||!S.wt)return;if(S.wt.get(hash))return;
          try{
            const t=S.wt.add(new Uint8Array(buf),{announce:CFG.trackers});
            t.on('error',function(e){if((e.message||'').indexOf('duplicate')>=0)return;warn('IDB torrent:',e.message);});
            t.on('metadata',function(){log('IDB seed ready:',t.name);});
          }catch(e){if((e.message||'').indexOf('duplicate')>=0)return;warn('IDB add:',hash,e.message);}
        });
      });
    };
  }catch(e){warn('IDB getAllKeys:',e);}
}

// ── CHAT HOOK ─────────────────────────────────────────────────
function hookChat(){
  if(!window.socket){setTimeout(hookChat,800);return;}
  socket.on('chatMsg',function(d){
    const raw=(d.msg||'').trim();if(!raw.startsWith(CFG.cmd))return;
    const body=decodeBody(raw.slice(CFG.cmd.length).trim());
    if(body.startsWith('magnet:')){if(d.username===S.myName)cmdMagnet(body);return;}
    const mk=body.match(/^magnet\s+(magnet:.+)$/i);if(mk){if(d.username===S.myName)cmdMagnet(mk[1]);return;}
    const parts=body.split(/\s+/),cmd=parts[0]||'',args=parts.slice(1);
    onCmd(d.username,cmd,args,body);
  });
  socket.on('rank',function(r){S.myRank=r;log('rank:',r);});
  socket.on('login',function(d){if(d&&d.name){S.myName=d.name;if(d.rank!==undefined)S.myRank=d.rank;log('login:',S.myName,'rank:',S.myRank);}});
  socket.on('setLeader',function(name){if(name===S.myName){log('setLeader: leader');if(S.video&&S.torrent)startSyncTimer();}});
  socket.on('changeMedia',function(data){if(S.state!=='IDLE'&&data&&data.type&&data.type!=='cu'){log('changeMedia: stopping HS');stopAll(false);}});
  log('chat hooked');
}

function onCmd(sender,cmd,args,body){
  if(cmd==='_m'||cmd==='_t')return;
  if(cmd==='_i'){
    const res=decodeRelay(args[0]||'',args[1]||'-');
    log('_i hash='+res.hash+' ws='+(res.ws?res.ws.slice(0,60):'(none)'));
    if(S.state!=='IDLE'){log('_i: not IDLE, ignore');return;}
    const cached=S.wt?S.wt.get(res.hash):null;
    if(cached&&cached.files&&cached.files.length){
      S.torrent=cached;S.activeWs=res.ws||null;transition('BUFFERING');
      attachVideo(cached,res.ws||null);startHUD(cached);startSyncTimer();return;
    }
    startSwarm(res.hash,res.ws||null,null);return;
  }
  if(cmd==='_s'){applySync(parseFloat(args[0]));return;}
  if(cmd==='help'){cmdHelp();return;}
  if(cmd==='status'){dumpStatus();cmdStatus();return;}
  if(cmd==='info'){cmdInfo(parseInt(args[0]));return;}
  if(cmd==='stop'){stopAll(false);return;}
  if(cmd==='search'&&sender===S.myName){cmdSearch(args.join(' '));return;}
  if(cmd==='archive'&&sender===S.myName){cmdArchive(args.join(' '));return;}
  if(cmd==='top'&&sender===S.myName){cmdTop();return;}
  if(cmd==='trackers'&&sender===S.myName){cmdTrackers();return;}
  if(cmd==='pick'&&sender===S.myName){const n=parseInt(args[0]);if(!isNaN(n))cmdPick(n);return;}
  if(cmd==='url'&&sender===S.myName){cmdUrl(body?body.slice(4).trim():args[0]||'');return;}
  if(cmd==='add'&&sender===S.myName){cmdAdd(body?body.slice(4).trim():args.join(' '));return;}
  if(cmd==='queue'&&sender===S.myName){playlistShow();return;}
  if(cmd==='next'&&sender===S.myName){playlistAdvance();return;}
  if(cmd==='clear'&&sender===S.myName){playlistClear();return;}
  if((cmd==='peers'||cmd==='wires')&&sender===S.myName){cmdPeers();return;}
  if(/^[0-9a-f]{40}$/i.test(cmd)&&sender===S.myName){cmdPickHash(cmd.toLowerCase());return;}
  if(cmd==='pt'&&sender===S.myName){if(args[0])cmdPt(args[0]);return;}
  if(cmd==='magnet'&&sender===S.myName){cmdMagnet(body?body.slice(7).trim():args.join(' '));return;}
  if(cmd==='sync'&&sender===S.myName&&S.video){relay('_s '+S.video.currentTime.toFixed(2));return;}
  if(cmd==='seek'&&sender===S.myName){const t=parseFloat(args[0]);if(!isNaN(t))relay('_s '+t.toFixed(2));return;}
}

function cmdHelp(){chat('HiveStream v'+V+': top | search <q> | pick <n> | url <https://…> | magnet <uri> | pt <url> | <hash> | peers | add <…> | queue | next | clear | trackers | sync | seek <s> | stop | status');}
function cmdStatus(){
  const q=S.playlist.length;
  if(!S.torrent){chat('v'+V+' '+S.state+' | queue:'+q);return;}
  const t=S.torrent,pct=t.length?(t.downloaded/t.length*100).toFixed(1):'?';
  let rtc=0,wsp=0;if(t.wires)t.wires.forEach(function(w){if(w.type==='webSeed')wsp++;else rtc++;});
  chat(S.state+' · '+pct+'% · '+rtc+'🔗rtc '+wsp+'🌐ws · '+fmtSpd(t.downloadSpeed)+'▼ '+fmtSpd(t.uploadSpeed)+'▲ | queue:'+q);
}
function cmdInfo(n){const v=S.results[n-1];if(!v){chat('No result '+n);return;}chat('['+n+'] '+v.name+' | '+fmtDur(v.duration)+' | '+(v.account&&v.account.host||'?'));}

// ── IDENTITY ──────────────────────────────────────────────────
function detectSelf(){
  try{if(window.CLIENT){S.myName=CLIENT.name||'';S.myRank=CLIENT.rank!==undefined?CLIENT.rank:-1;}}catch(e){}
  if(!S.myName){const sels=['#username-display','#guestname-display','.username'];for(let i=0;i<sels.length;i++){const el=document.querySelector(sels[i]);if(el&&el.textContent.trim()){S.myName=el.textContent.trim();break;}}}
  if(!S.myName){const w=document.getElementById('welcome');if(w)S.myName=w.textContent.replace(/^Welcome,?\s*/i,'').replace(/[!.]+$/,'').trim();}
  log('identity: name='+S.myName+' rank='+S.myRank+' coord='+isCoordinator());
}

function hookErrors(){
  window.addEventListener('error',function(e){dbWrite('E',['UNCAUGHT: '+e.message+' @ '+e.filename+':'+e.lineno]);});
  window.addEventListener('unhandledrejection',function(e){dbWrite('E',['PROMISE: '+(e.reason&&e.reason.message?e.reason.message:String(e.reason))]);});
}

// ── BOOT ──────────────────────────────────────────────────────
function boot(){
  log('v'+V+' booting');
  hookErrors();
  loadScript('https://cdn.jsdelivr.net/npm/webtorrent@1/webtorrent.min.js',function(){
    log('WebTorrent loaded');
    S.wt=mkClient();detectSelf();openIDB();
    if(!CFG.seedOnly)buildUI();
    hookChat();
    chat('HiveStream v'+V+' ready — !hs help');
    log('boot done | coord:'+isCoordinator()+' name:'+S.myName+' rank:'+S.myRank);
  });
}
function loadScript(src,cb){
  if(document.querySelector('script[src="'+src+'"]')){cb();return;}
  const s=document.createElement('script');s.src=src;s.onload=cb;
  s.onerror=function(){errlog('CDN load failed:',src);cb();};
  document.head.appendChild(s);
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
else boot();

})();
