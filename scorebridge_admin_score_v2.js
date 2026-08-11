  // ---- musí sedět s firmwarem ----
  const DEVICE_ID = "sb-test-7431";
  const BROKER    = "wss://broker.hivemq.com:8884/mqtt";
  // --------------------------------
  const T_CMD    = `scorebridge/${DEVICE_ID}/cmd`;
  const T_STATUS = `scorebridge/${DEVICE_ID}/status`;
  const T_EVENT  = `scorebridge/${DEVICE_ID}/event`;
  const T_LEARN_CMD = `scorebridge/${DEVICE_ID}/learn/cmd`;
  const T_LEARN_STATUS = `scorebridge/${DEVICE_ID}/learn/status`;
  const T_LEARN_SAMPLE = `scorebridge/${DEVICE_ID}/learn/sample`;
  const T_PROFILE_CMD = `scorebridge/${DEVICE_ID}/profile/cmd`;
  const T_PROFILE_STATUS = `scorebridge/${DEVICE_ID}/profile/status`;
  const T_PROFILE_CHUNK = `scorebridge/${DEVICE_ID}/profile/chunk`;
  const T_PROFILE_DATA = `scorebridge/${DEVICE_ID}/profile/data`;
  const MAXPTS = 30;
  const mqttExtensionListeners = new Set();
  const mqttConnectionListeners = new Set();
  const notifyMqttConnection = connected => mqttConnectionListeners.forEach(listener=>{
    try{ listener(connected); }catch(error){ log('Chyba doplňku: '+error.message); }
  });

  document.getElementById('devid').textContent = DEVICE_ID;
  const $ = id => document.getElementById(id);
  const now = () => new Date().toLocaleTimeString('cs-CZ');
  const log = (m) => {
    const l=$('log'), timestamp=document.createElement('span');
    timestamp.className='t';
    timestamp.textContent=`[${now()}]`;
    l.append(timestamp,document.createTextNode(` ${String(m)}\n`));
    l.scrollTop=l.scrollHeight;
  };

  // ---- SCORE + HERNÍ ČAS ----
  const displayedScores = {home:null, away:null};
  function updateScore(id, side, value){
    const el=$(id), next=String(value), previous=displayedScores[side];
    el.textContent=next;
    if(previous!==null && previous!==next){
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    displayedScores[side]=next;
    refreshLiveScoreModal();
  }
  $('homeScore').addEventListener('animationend', e=>e.currentTarget.classList.remove('flash'));
  $('awayScore').addEventListener('animationend', e=>e.currentTarget.classList.remove('flash'));

  const FIRST_HALF_MS = 45*60*1000;
  const MATCH_END_MS = 90*60*1000;
  const HALF_WAIT_MS = 4*60*1000;
  const END_WAIT_MS = 7*60*1000;
  let derbyPowerState=false;
  let deviceEnabledState=true;
  let remoteClockState=null;
  const matchTimer={
    authoritative:false,phase:'pregame',elapsedMs:0,segmentStartedAt:null,
    holdStartedAt:null,phaseRemainingS:0,snapshotAt:Date.now()
  };

  function currentMatchMs(at=Date.now()){
    const runningPhase=matchTimer.phase==='first'||matchTimer.phase==='second';
    return matchTimer.elapsedMs+(runningPhase&&remoteClockState===true&&matchTimer.segmentStartedAt
      ? at-matchTimer.segmentStartedAt : 0);
  }
  function formatMatchTime(ms){
    const seconds=Math.max(0,Math.floor(ms/1000));
    return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  }
  function updateScoreboardState(){
    const board=$('scoreboard');
    board.classList.remove('state-off','state-ready','state-running');
    board.classList.add(!deviceEnabledState||!derbyPowerState?'state-off':remoteClockState===true?'state-running':'state-ready');
    refreshLiveScoreModal();
  }
  function updateDevicePowerControls(){
    ['devicePowerButton','modalDevicePowerButton'].forEach(id=>{
      const button=$(id); if(!button) return;
      button.textContent=deviceEnabledState?'Vypnout zařízení':'Zapnout zařízení';
      button.classList.toggle('is-on',deviceEnabledState);
      button.classList.toggle('is-off',!deviceEnabledState);
      button.setAttribute('aria-pressed',String(deviceEnabledState));
      button.title=deviceEnabledState?'Přepnout zařízení do vzdáleného soft OFF režimu':'Znovu aktivovat zařízení';
    });
  }
  function updateClockToggleControls(){
    const running=remoteClockState===true;
    ['clockToggleButton','modalClockToggleButton'].forEach(id=>{
      const button=$(id); if(!button) return;
      button.textContent=running?'Zastavit čas':'Spustit čas';
      button.classList.toggle('is-running',running);
      button.classList.toggle('is-stopped',!running);
      button.setAttribute('aria-pressed',String(running));
      button.disabled=!deviceEnabledState;
      button.title=deviceEnabledState?(running?'Zastavit běžící časomíru':'Spustit časomíru'):'Nejdříve zapněte zařízení';
    });
  }
  function toggleDevicePower(){
    if(deviceEnabledState) openDeviceOffModal();
    else cmd('device_on');
  }
  function toggleClockControl(){
    if(!deviceEnabledState) return log('Nejdříve zapněte zařízení');
    cmd(remoteClockState===true?'clock_stop':'clock_start');
  }
  function setClockIndicator(on){
    const status=$('clockStatus');
    status.textContent=on?'běží':'stojí';
    status.className='metric-value state-text '+(on?'on':'wait');
    $('clockStatusCell').className='status-cell '+(on?'tone-on':'tone-wait');
    updateClockToggleControls();
  }
  function renderMatchClock(at=Date.now()){
    let elapsed=currentMatchMs(at);

    if(!matchTimer.authoritative&&matchTimer.phase==='first'&&elapsed>=FIRST_HALF_MS){
      matchTimer.phase='half_hold';
      matchTimer.elapsedMs=FIRST_HALF_MS;
      matchTimer.segmentStartedAt=null;
      matchTimer.holdStartedAt=at;
      elapsed=FIRST_HALF_MS;
    }
    if(!matchTimer.authoritative&&matchTimer.phase==='half_hold'&&at-matchTimer.holdStartedAt>=HALF_WAIT_MS){
      matchTimer.phase='halftime';
    }
    if(!matchTimer.authoritative&&matchTimer.phase==='second'&&elapsed>=MATCH_END_MS){
      matchTimer.phase='end_hold';
      matchTimer.elapsedMs=MATCH_END_MS;
      matchTimer.segmentStartedAt=null;
      matchTimer.holdStartedAt=at;
      elapsed=MATCH_END_MS;
    }
    if(!matchTimer.authoritative&&matchTimer.phase==='end_hold'&&at-matchTimer.holdStartedAt>=END_WAIT_MS){
      matchTimer.phase='ended';
    }

    const clock=$('matchClock'), state=$('matchState');
    if(matchTimer.phase==='pregame'){
      clock.textContent='0:00'; state.textContent='čekám na spuštění času';
    } else if(matchTimer.phase==='first'){
      clock.textContent=formatMatchTime(Math.min(elapsed,FIRST_HALF_MS));
      state.textContent='1. poločas · '+(remoteClockState===true?'čas běží':'čas stojí');
    } else if(matchTimer.phase==='half_hold'){
      const remaining=matchTimer.authoritative?Math.max(0,Math.ceil(matchTimer.phaseRemainingS-(at-matchTimer.snapshotAt)/1000)):Math.max(0,Math.ceil((HALF_WAIT_MS-(at-matchTimer.holdStartedAt))/1000));
      clock.textContent='45:00 (Poločas)'; state.textContent='čekám '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0');
    } else if(matchTimer.phase==='halftime'){
      clock.textContent='Poločas'; state.textContent='čekám na spuštění času';
    } else if(matchTimer.phase==='second'){
      clock.textContent=formatMatchTime(Math.min(elapsed,MATCH_END_MS));
      state.textContent='2. poločas · '+(remoteClockState===true?'čas běží':'čas stojí');
    } else if(matchTimer.phase==='end_hold'){
      const remaining=matchTimer.authoritative?Math.max(0,Math.ceil(matchTimer.phaseRemainingS-(at-matchTimer.snapshotAt)/1000)):Math.max(0,Math.ceil((END_WAIT_MS-(at-matchTimer.holdStartedAt))/1000));
      clock.textContent='90:00 (Konec)'; state.textContent='čekám '+Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0');
    } else {
      clock.textContent='Konec'; state.textContent='zápas ukončen';
    }
    refreshLiveScoreModal();
  }
  function applyClockSnapshot(data){
    const seconds=Number(data.match_elapsed_s),remaining=Number(data.phase_remaining_s);
    const validPhases=new Set(['pregame','first','half_hold','halftime','second','end_hold','ended']);
    if(!Number.isFinite(seconds)||seconds<0||!validPhases.has(data.clock_phase)) return false;
    const at=Date.now();
    matchTimer.authoritative=true;
    matchTimer.phase=data.clock_phase;
    matchTimer.elapsedMs=Math.min(seconds*1000,MATCH_END_MS);
    matchTimer.phaseRemainingS=Number.isFinite(remaining)&&remaining>=0?remaining:0;
    matchTimer.snapshotAt=at;
    remoteClockState=!!data.clock_running;
    matchTimer.segmentStartedAt=remoteClockState&&(matchTimer.phase==='first'||matchTimer.phase==='second')?at:null;
    setClockIndicator(remoteClockState);
    updateScoreboardState();
    renderMatchClock(at);
    return true;
  }
  function handleClockSignal(on){
    const at=Date.now(), previous=remoteClockState;
    if(matchTimer.authoritative){
      if(previous===true&&on===false){ matchTimer.elapsedMs=currentMatchMs(at); matchTimer.segmentStartedAt=null; }
      remoteClockState=on;
      if(on&&!matchTimer.segmentStartedAt&&(matchTimer.phase==='first'||matchTimer.phase==='second')) matchTimer.segmentStartedAt=at;
      setClockIndicator(on); updateScoreboardState(); renderMatchClock(at); return;
    }
    if(previous===true&&on===false&&(matchTimer.phase==='first'||matchTimer.phase==='second')){
      matchTimer.elapsedMs=currentMatchMs(at);
      matchTimer.segmentStartedAt=null;
    }
    remoteClockState=on;

    if(on===true&&previous!==true){
      if(matchTimer.phase==='pregame'){
        matchTimer.phase='first';
        matchTimer.elapsedMs=0;
        matchTimer.segmentStartedAt=at;
      } else if((matchTimer.phase==='first'||matchTimer.phase==='second')&&!matchTimer.segmentStartedAt){
        matchTimer.segmentStartedAt=at;
      } else if(matchTimer.phase==='halftime'){
        matchTimer.phase='second'; matchTimer.elapsedMs=FIRST_HALF_MS; matchTimer.segmentStartedAt=at;
      }
    }
    setClockIndicator(on);
    updateScoreboardState();
    renderMatchClock(at);
  }
  setInterval(()=>renderMatchClock(),250);

  // ---- MAP ----
  const map = L.map('map', {zoomControl:true, attributionControl:false}).setView([49.8,15.5], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {maxZoom:19}).addTo(map);
  let marker = null;
  function setMarker(lat, lon){
    if(!marker){ marker = L.circleMarker([lat,lon], {radius:9, color:'#b9ff2c', weight:3,
      fillColor:'#b9ff2c', fillOpacity:.85}).addTo(map); }
    else marker.setLatLng([lat,lon]);
    map.setView([lat,lon], 15);
  }

  // ---- CHARTS ----
  const mkChart = (ctx, sMin, sMax, color, fillColor) => new Chart(ctx, {
    type:'line',
    data:{ labels:[], datasets:[{ data:[], borderColor:color, borderWidth:2,
           backgroundColor:fillColor, fill:true, tension:.35, pointRadius:0 }]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{legend:{display:false}},
      scales:{ x:{display:false}, y:{ suggestedMin:sMin, suggestedMax:sMax,
        grid:{color:'rgba(148,163,184,.1)'}, ticks:{color:'#69778c', font:{size:9}} } } }
  });
  const chS = mkChart($('chSignal'), -110, -40, '#65d7ff', 'rgba(101,215,255,.08)');
  const chB = mkChart($('chBatt'), 0, 100, '#b9ff2c', 'rgba(185,255,44,.08)');
  const push = (ch,v)=>{ ch.data.labels.push(''); ch.data.datasets[0].data.push(v);
    if(ch.data.labels.length>MAXPTS){ch.data.labels.shift();ch.data.datasets[0].data.shift();} ch.update(); };

  // ---- SYNCHRONIZOVANÁ HISTORIE PŘÍKAZŮ ----
  const COMMAND_LABELS={
    HOME_PLUS:'Domácí +1',AWAY_PLUS:'Hosté +1',POWER_ON:'Tabule zapnuta',POWER_OFF:'Tabule vypnuta',
    START_STOP:'Start / stop',ADJUST:'Nastavení',TIME_ADD_TENTATIVE:'+1 minuta',
    MANUAL_HOME_PLUS:'Ručně domácí +1',MANUAL_HOME_MINUS:'Ručně domácí −1',
    MANUAL_AWAY_PLUS:'Ručně hosté +1',MANUAL_AWAY_MINUS:'Ručně hosté −1',
    MANUAL_SET_HOME:'Nastaveno skóre domácích',MANUAL_SET_AWAY:'Nastaveno skóre hostů',
    MANUAL_SCORE_RESET:'Skóre vynulováno',LOCAL_SCORE_RESET:'Lokální nulování skóre',
    DEVICE_ON:'Zařízení zapnuto',DEVICE_OFF:'Zařízení vypnuto',
    CLOCK_START:'Čas spuštěn',CLOCK_STOP:'Čas zastaven',CLOCK_TOGGLE:'Přepnutí času',CLOCK_RESET:'Čas vynulován',
    HALFTIME_WAIT:'Poločas – odpočet',HALFTIME:'Poločas',MATCH_END_WAIT:'Konec – odpočet',MATCH_END:'Konec zápasu',
    GPS_ON:'GPS zapnuto',GPS_OFF:'GPS vypnuto',REBOOTING:'Restart zařízení',UNKNOWN:'Neznámý RF příkaz'
  };
  let commandHistory=[];
  const commandLabel=value=>COMMAND_LABELS[value]||String(value||'–').replaceAll('_',' ');
  const commandMatchTime=seconds=>formatMatchTime(Math.max(0,Number(seconds)||0)*1000);
  const serialTimestamp=(date=new Date())=>
    String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0')+':'+
    String(date.getSeconds()).padStart(2,'0')+'.'+String(date.getMilliseconds()).padStart(3,'0');
  function setSerialMonitorLine(rawMessage){
    const line=serialTimestamp()+' -> '+rawMessage;
    ['matchSerialLine','modalSerialLine'].forEach(id=>{
      const element=$(id); if(element){ element.textContent=line; element.title=line; }
    });
  }
  function drawCommandHistory(container){
    if(!container) return;
    container.replaceChildren();
    if(!commandHistory.length){
      const empty=document.createElement('div'); empty.className='score-command-empty'; empty.textContent='Čekám na zprávy…'; container.append(empty); return;
    }
    commandHistory.slice(-6).reverse().forEach(item=>{
      const row=document.createElement('div'); row.className='score-command-row';
      const seq=document.createElement('span'); seq.className='command-seq'; seq.textContent='#'+item.seq;
      const name=document.createElement('strong'); name.textContent=commandLabel(item.event); name.title=item.event;
      const time=document.createElement('time'); time.textContent=commandMatchTime(item.match_s); time.title='Čas zápasu';
      row.append(seq,name,time); container.append(row);
    });
  }
  function renderCommandHistory(){
    drawCommandHistory($('scoreCommandFeed'));
    drawCommandHistory($('modalCommandFeed'));
  }
  function setLastCommand(eventName){
    if(!eventName) return;
    ['lastDerbyEvent','matchLastCommand','controlLastCommand'].forEach(id=>{
      const element=$(id); if(element){ element.textContent=commandLabel(eventName); element.title=eventName; }
    });
    refreshLiveScoreModal();
  }
  function syncCommandHistory(items){
    if(!Array.isArray(items)) return;
    const normalized=items.map(item=>({
      seq:Number(item?.seq),event:typeof item?.event==='string'?item.event:'',match_s:Number(item?.match_s)
    })).filter(item=>Number.isInteger(item.seq)&&item.seq>=0&&/^[A-Z0-9_]{1,31}$/.test(item.event)&&Number.isFinite(item.match_s)&&item.match_s>=0)
      .sort((a,b)=>a.seq-b.seq).slice(-8);
    if(normalized.length){ commandHistory=normalized; setLastCommand(normalized.at(-1).event); renderCommandHistory(); }
  }
  function addCommandEvent(data){
    const event=typeof data?.event==='string'&&/^[A-Z0-9_]{1,31}$/.test(data.event)?data.event:'';
    if(!event) return;
    const seq=Number.isInteger(Number(data.event_seq))?Number(data.event_seq):Date.now();
    const matchSeconds=Number.isFinite(Number(data.match_elapsed_s))?Number(data.match_elapsed_s):0;
    if(!commandHistory.some(item=>item.seq===seq)) commandHistory.push({seq,event,match_s:matchSeconds});
    commandHistory=commandHistory.sort((a,b)=>a.seq-b.seq).slice(-8);
    setLastCommand(event); renderCommandHistory();
  }
  function setDeviceEnabled(on){
    deviceEnabledState=!!on;
    const state=$('deviceStatus');
    state.textContent=deviceEnabledState?'zapnuto':'soft vypnuto';
    state.className='state-text '+(deviceEnabledState?'on':'off');
    $('deviceStatusCell').className='status-cell '+(deviceEnabledState?'tone-on':'tone-off');
    updateDevicePowerControls();
    updateClockToggleControls();
    updateScoreboardState();
  }
  function updateBattery(data){
    if(data.batt_pct===undefined&&data.batt_mv===undefined&&data.batt_valid===undefined) return;
    const pct=Number(data.batt_pct),mv=Number(data.batt_mv);
    const valid=data.batt_valid!==false&&Number.isFinite(pct)&&pct>=0&&pct<=100&&Number.isFinite(mv)&&mv>=3000&&mv<=4400;
    $('batt').textContent=valid?Math.round(pct):'–';
    $('battmv').textContent=Number.isFinite(mv)&&mv>0?Math.round(mv):'–';
    $('batt').title=valid?`Měřeno z GPIO35: ${Math.round(mv)} mV`:'Měření baterie není platné';
    if(valid) push(chB,Math.round(pct));
  }

  // ---- MQTT ----
  const client = mqtt.connect(BROKER, { clientId:'panel-'+Math.random().toString(16).slice(2) });
  client.on('connect', ()=>{ setConn(true); log('Připojeno k brokeru');
    client.subscribe([T_STATUS,T_EVENT,T_LEARN_STATUS,T_LEARN_SAMPLE,T_PROFILE_STATUS,`${T_PROFILE_DATA}/#`],
      error=>log(error?'Chyba odběru MQTT: '+error.message:'Poslouchám stav, DERBY události a kalibraci'));
    notifyMqttConnection(true);
    cmd('all'); });
  client.on('reconnect', ()=>log('Znovupřipojování…'));
  client.on('close', ()=>{ setConn(false); notifyMqttConnection(false); });
  client.on('error', e=>log('Chyba: '+e));

  client.on('message', (t,msg)=>{
    mqttExtensionListeners.forEach(listener=>{
      try{ listener(t,msg); }catch(error){ log('Chyba doplňku: '+error.message); }
    });
    if(t!==T_STATUS&&t!==T_EVENT) return;
    const rawMessage=msg.toString();
    let d; try{ d=JSON.parse(rawMessage); }catch(e){ return log('Neplatná zpráva'); }
    if(!d||typeof d!=='object'||Array.isArray(d)) return log('Neplatný tvar MQTT zprávy');
    setSerialMonitorLine(rawMessage);
    const actionTime=now();
    $('updated').textContent = actionTime;
    $('lastAction').textContent = actionTime;

    if(d.home!==undefined) updateScore('homeScore','home',d.home);
    if(d.away!==undefined) updateScore('awayScore','away',d.away);

    if(d.device_enabled!==undefined) setDeviceEnabled(!!d.device_enabled);

    if(d.match_elapsed_s!==undefined&&d.clock_phase!==undefined){
      applyClockSnapshot(d);
    } else if(d.clock_running!==undefined){
      handleClockSignal(!!d.clock_running);
    }

    if(d.derby_power!==undefined){
      const p=$('derbyPower');
      derbyPowerState=!!d.derby_power;
      p.className='metric-value state-text '+(derbyPowerState?'on':'off');
      p.textContent=derbyPowerState?'zapnuta':'vypnuta';
      $('powerStatusCell').className='status-cell '+(derbyPowerState?'tone-on':'tone-off');
      updateScoreboardState();
    }

    if(Array.isArray(d.event_history)) syncCommandHistory(d.event_history);
    if(d.last_event&&!d.event) setLastCommand(d.last_event);
    if(d.event) setLastCommand(d.event);

    if(t===T_EVENT){
      addCommandEvent(d);
      log('⚽ Příkaz: '+commandLabel(d.event||'?')+' · '+(d.home??'?')+':'+(d.away??'?'));
      return;
    }

    // stisk tlačítka na desce -> přepnutí Záznam
    if(d.reply==='button' || d.rec!==undefined){
      const on = !!d.rec; const e=$('rec');
      e.className='pill '+(on?'rec-on':'rec-off');
      e.innerHTML='<span class="dot"></span>'+(on?'ZÁZNAM':'záznam vypnut');
      log('🔴 Tlačítko na desce → záznam '+(on?'ZAPNUT':'vypnut'));
      return;
    }
    log('Stav ('+(d.reply||'?')+')');

    if(d.signal_dbm!==undefined){ $('signal').textContent=d.signal_dbm||'–'; setSigBars(d.signal_csq); if(d.signal_dbm) push(chS,d.signal_dbm); }
    updateBattery(d);
    if(d.uptime_s!==undefined) $('uptime').textContent=fmtUp(d.uptime_s);
    if(d.gps_on!==undefined){
      const gpsOn=!!d.gps_on, gps=$('gpsstate');
      gps.textContent=gpsOn?'zapnuto':'vypnuto';
      gps.className='metric-value state-text '+(gpsOn?'on':'off');
      gpsState=gpsOn;
      setGpsSwitch(gpsOn);
    }

    const numericLat=Number(d.lat),numericLon=Number(d.lon);
    if(d.gps_fix&&Number.isFinite(numericLat)&&Number.isFinite(numericLon)&&
       numericLat>=-90&&numericLat<=90&&numericLon>=-180&&numericLon<=180){
      const lat=numericLat, lon=numericLon;
      $('gpsbadge').textContent = 'fix nalezen';
      $('gpsbadge').style.color = '#166534';
      $('coords').innerHTML = `Souřadnice: <b>${lat.toFixed(6)}, ${lon.toFixed(6)}</b> · <a target="_blank" href="https://www.google.com/maps?q=${lat},${lon}">Otevřít v Google Maps →</a>`;
      setMarker(lat, lon);
    } else if(d.gps_on){
      $('gpsbadge').textContent = 'hledám satelity…';
    }
  });

  function cmd(c){ if(!client.connected)return log('Nejsem připojen k brokeru');
    client.publish(T_CMD,c,{qos:0,retain:false}); $('lastAction').textContent=now(); log('→ příkaz: '+c); }
  let gpsState=false;
  function toggleGps(){ gpsState=!gpsState; setGpsSwitch(gpsState); cmd(gpsState?'gpson':'gpsoff'); }
  function setGpsSwitch(on){
    ['gpsSwitch','modalGpsSwitch'].forEach(id=>{
      const button=$(id); if(!button) return;
      button.classList.toggle('on',on);
      button.textContent=on?'GPS zapnuto':'GPS vypnuto';
      button.setAttribute('aria-checked',String(on));
    });
  }
  function setConn(ok){ const e=$('conn');
    e.className='pill '+(ok?'on':'off'); e.innerHTML='<span class="dot"></span>'+(ok?'připojeno':'odpojeno'); }
  function setSigBars(csq){ const bars=document.querySelectorAll('#sigbars i');
    const lvl = csq>=31?5:csq>=20?4:csq>=13?3:csq>=8?2:csq>0?1:0;
    bars.forEach((b,i)=>b.className = i<lvl?'a':''); }
  function fmtUp(s){ const h=Math.floor(s/3600),m=Math.floor(s%3600/60); return h+'h '+m+'m'; }

  // ---- MODAL WORKSPACE ----
  let activeModalView=null;
  let modalReturnFocus=null;
  const modalText=id=>($(id)?.textContent||'–').trim()||'–';
  const escapeModalHtml=value=>String(value??'–')
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const modalStat=(label,value,tone='')=>`<div class="modal-stat ${tone}"><span>${escapeModalHtml(label)}</span><strong>${escapeModalHtml(value)}</strong></div>`;

  function showAppModal({eyebrow='ScoreBridge admin',title,body,footer='',compact=false,fullscreen=false}){
    const backdrop=$('appModal');
    if(!backdrop.classList.contains('open')) modalReturnFocus=document.activeElement;
    $('appModalEyebrow').textContent=eyebrow;
    $('appModalTitle').textContent=title;
    $('appModalBody').innerHTML=body;
    $('appModalFooter').innerHTML=footer;
    $('appModalFooter').hidden=!footer;
    $('appModalDialog').classList.toggle('compact',compact);
    $('appModalDialog').classList.toggle('fullscreen',fullscreen);
    backdrop.classList.toggle('fullscreen-open',fullscreen);
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden','false');
    document.body.classList.add('modal-open');
    requestAnimationFrame(()=>$('appModalClose').focus());
  }

  function closeAppModal(){
    document.dispatchEvent(new CustomEvent('scorebridge:modal-before-close',{detail:{view:activeModalView}}));
    const backdrop=$('appModal');
    backdrop.classList.remove('open');
    backdrop.classList.remove('fullscreen-open');
    backdrop.setAttribute('aria-hidden','true');
    document.body.classList.remove('modal-open');
    activeModalView=null;
    if(modalReturnFocus&&document.contains(modalReturnFocus)) modalReturnFocus.focus();
    modalReturnFocus=null;
  }

  function refreshLiveScoreModal(){
    if(activeModalView!=='score'||!$('modalLiveScore')) return;
    const modalScore=$('modalLiveScore');
    const tone=$('scoreboard').classList.contains('state-running')?'state-running':
      $('scoreboard').classList.contains('state-ready')?'state-ready':'state-off';
    modalScore.className='modal-score '+tone;
    $('modalHomeScore').textContent=modalText('homeScore');
    $('modalAwayScore').textContent=modalText('awayScore');
    $('modalMatchClock').textContent=modalText('matchClock');
    $('modalMatchState').textContent=modalText('matchState');
    $('modalLastCommand').textContent=modalText('matchLastCommand');
    $('modalSerialLine').textContent=modalText('matchSerialLine');
  }

  function openPanelModal(view){
    document.dispatchEvent(new CustomEvent('scorebridge:modal-view-changing',{detail:{from:activeModalView,to:view}}));
    activeModalView=view;
    const signal=modalText('signal')+' dBm';
    const battery=modalText('batt')+' %';
    const gps=modalText('gpsstate');
    const uptime=modalText('uptime');
    const power=modalText('derbyPower');
    const clock=modalText('clockStatus');
    const command=modalText('lastDerbyEvent');
    const scoreTone=$('scoreboard').classList.contains('state-running')?'state-running':
      $('scoreboard').classList.contains('state-ready')?'state-ready':'state-off';
    const powerTone=derbyPowerState?'on':'off';
    const clockTone=remoteClockState===true?'on':'wait';
    const gpsTone=$('gpsstate').classList.contains('on')?'on':'off';
    let config;

    if(view==='dashboard'){
      config={eyebrow:'Admin přehled',title:'Přehled zařízení',body:`
        <div class="modal-overview-grid">
          ${modalStat('Signál',signal)}${modalStat('Baterie',battery)}
          ${modalStat('GPS',gps,gpsTone)}${modalStat('Uptime',uptime)}
          ${modalStat('Zařízení',deviceEnabledState?'zapnuto':'soft vypnuto',deviceEnabledState?'on':'off')}
          ${modalStat('Tabule',power,powerTone)}${modalStat('Časomíra',clock,clockTone)}
          ${modalStat('Skóre',modalText('homeScore')+' : '+modalText('awayScore'))}
          ${modalStat('Poslední příkaz',command,'wait')}
        </div>
        <div class="modal-note">Souhrn právě zobrazených dat zařízení <b>${escapeModalHtml(modalText('devid'))}</b>. Nové hodnoty se načtou příkazem „Načíst aktuální stav“.</div>`};
    } else if(view==='score'){
      config={eyebrow:'Živé ovládání zápasu',title:'Živé skóre',fullscreen:true,body:`
        <div class="modal-score ${scoreTone}" id="modalLiveScore">
          <div><div class="modal-score-label">Domácí</div><div class="modal-score-value" id="modalHomeScore">${escapeModalHtml(modalText('homeScore'))}</div></div>
          <div><div class="modal-score-time" id="modalMatchClock">${escapeModalHtml(modalText('matchClock'))}</div><div class="modal-score-state" id="modalMatchState">${escapeModalHtml(modalText('matchState'))}</div><div class="modal-score-command" id="modalLastCommand">${escapeModalHtml(modalText('matchLastCommand'))}</div></div>
          <div><div class="modal-score-label">Hosté</div><div class="modal-score-value" id="modalAwayScore">${escapeModalHtml(modalText('awayScore'))}</div></div>
          <div class="modal-score-serial-strip" id="modalSerialLine" title="${escapeModalHtml(modalText('matchSerialLine'))}">${escapeModalHtml(modalText('matchSerialLine'))}</div>
        </div>`,footer:`<button onclick="closeAppModal()">Zavřít</button><button onclick="cmd('all')">Načíst aktuální stav</button><button class="modal-confirm" onclick="openPanelModal('controls')">Ovládání zařízení</button>`};
    } else if(view==='controls'){
      config={eyebrow:'Vzdálené ovládání',title:'Ovládání zařízení',body:`
        <div class="modal-control-grid">
          <button class="modal-reset" onclick="openResetModal()">Vynulovat skóre</button>
          <button id="modalDevicePowerButton" class="device-power-control ${deviceEnabledState?'is-on':'is-off'}" onclick="toggleDevicePower()" aria-pressed="${deviceEnabledState}">${deviceEnabledState?'Vypnout zařízení':'Zapnout zařízení'}</button>
          <button id="modalClockToggleButton" class="clock-toggle-control ${remoteClockState===true?'is-running':'is-stopped'}" onclick="toggleClockControl()" aria-pressed="${remoteClockState===true}" ${deviceEnabledState?'':'disabled'}>${remoteClockState===true?'Zastavit čas':'Spustit čas'}</button>
          <button class="clock-reset-control" onclick="openClockResetModal()">Vynulovat čas</button>
          <button class="control-refresh" onclick="cmd('all')">Načíst aktuální stav</button>
          <button class="control-location" onclick="cmd('gps')">Aktualizovat polohu</button>
          <button id="modalGpsSwitch" class="gps-toggle ${gpsState?'on':''}" role="switch" aria-checked="${gpsState}" onclick="toggleGps()">${escapeModalHtml(gpsState?'GPS zapnuto':'GPS vypnuto')}</button>
          <button class="restart-control" onclick="openRestartModal()">Restartovat zařízení</button>
        </div>
        <div class="modal-note">Poslední přijatý příkaz: <b>${escapeModalHtml(command)}</b>. Příkazy jsou odesílány přes MQTT na zařízení ${escapeModalHtml(modalText('devid'))}.</div>`};
    } else if(view==='telemetry'){
      config={eyebrow:'Systémová telemetrie',title:'Telemetrie zařízení',body:`
        <div class="modal-overview-grid">
          ${modalStat('Signál',signal)}${modalStat('Baterie',battery)}
          ${modalStat('Napětí',modalText('battmv')+' mV')}${modalStat('GPS',gps,gpsTone)}
          ${modalStat('Uptime',uptime)}${modalStat('Poslední akce',modalText('lastAction'))}
        </div>
        <div class="modal-note">Grafy v hlavním dashboardu uchovávají posledních 30 vzorků signálu a baterie.</div>`};
    } else if(view==='log'){
      const logText=($('log').innerText||$('log').textContent||'Žádné zprávy.').trim()||'Žádné zprávy.';
      config={eyebrow:'Historie příkazů',title:'Log zpráv',body:`<pre class="modal-log">${escapeModalHtml(logText)}</pre>`};
    } else if(view==='map'){
      config={eyebrow:'Polohové služby',title:'Poloha zařízení',body:`
        <div class="modal-map-readout">
          <div class="modal-map-card"><span>GPS modul</span><strong>${escapeModalHtml(gps)}</strong></div>
          <div class="modal-map-card"><span>Stav fixu</span><strong>${escapeModalHtml(modalText('gpsbadge'))}</strong></div>
          <div class="modal-map-card" style="grid-column:1/-1"><span>Souřadnice</span><strong>${escapeModalHtml(modalText('coords'))}</strong></div>
        </div>`,footer:`<button onclick="closeAppModal()">Zavřít</button><button class="modal-confirm" onclick="cmd('gps')">Aktualizovat polohu</button>`};
    } else if(view==='signal'){
      const activeBars=document.querySelectorAll('#sigbars i.a').length;
      config={eyebrow:'Diagnostika rádia',title:'Analýza signálu',body:`
        <div class="modal-overview-grid">${modalStat('Aktuální RSSI',signal)}${modalStat('Aktivní úroveň',activeBars+' / 5')}${modalStat('Poslední akce',modalText('lastAction'))}${modalStat('Připojení',modalText('conn'),$('conn').classList.contains('on')?'on':'off')}</div>
        <div class="modal-note">Vyšší počet aktivních dílků znamená stabilnější mobilní spojení. Detailní průběh je v grafu „Signál“.</div>`};
    } else if(view==='battery'){
      config={eyebrow:'Diagnostika napájení',title:'Stav baterie',body:`
        <div class="modal-overview-grid">${modalStat('Kapacita',battery,'on')}${modalStat('Napětí',modalText('battmv')+' mV')}${modalStat('Uptime',uptime)}${modalStat('Poslední akce',modalText('lastAction'))}</div>
        <div class="modal-note">Napětí se měří na bateriovém vstupu GPIO35 přes dělič desky. Neplatná hodnota se nezobrazí jako falešných 0 %. Graf uchovává posledních 30 platných vzorků.</div>`};
    } else if(view==='connection'){
      const connected=$('conn').classList.contains('on');
      config={eyebrow:'MQTT připojení',title:'Stav připojení',body:`
        <div class="modal-overview-grid">${modalStat('Broker',connected?'připojeno':'odpojeno',connected?'on':'off')}${modalStat('Zařízení',modalText('devid'))}${modalStat('Aktualizace',modalText('updated'))}${modalStat('Poslední příkaz',command,'wait')}</div>
        <div class="modal-note">Broker: <b>broker.hivemq.com</b> · WebSocket MQTT port 8884.</div>`};
    } else {
      const recording=$('rec').classList.contains('rec-on');
      config={eyebrow:'Stav záznamu',title:'Záznam zařízení',body:`
        <div class="modal-overview-grid">${modalStat('Záznam',recording?'zapnut':'vypnut',recording?'on':'off')}${modalStat('Poslední akce',modalText('lastAction'))}${modalStat('Uptime',uptime)}${modalStat('Zařízení',modalText('devid'))}</div>
        <div class="modal-note">Záznam se přepíná fyzickým tlačítkem na zařízení a jeho stav se propisuje do horní systémové lišty.</div>`};
    }
    showAppModal(config);
    if(view==='score') renderCommandHistory();
  }

  function openResetModal(){
    activeModalView='confirm-reset';
    showAppModal({eyebrow:'Potvrzení příkazu',title:'Vynulovat skóre?',compact:true,body:`
      <div class="confirm-visual"><div class="confirm-icon">0:0</div><div class="confirm-copy"><h3>Vrátit skóre na nulu</h3><p>Domácí i hosté budou nastaveni na hodnotu 0. Příkaz se okamžitě odešle do zařízení přes MQTT.</p></div></div>`,
      footer:`<button onclick="closeAppModal()">Zrušit</button><button class="modal-confirm" onclick="confirmScoreReset()">Vynulovat skóre</button>`});
  }
  function confirmScoreReset(){ cmd('score_reset'); closeAppModal(); }

  function openClockResetModal(){
    activeModalView='confirm-clock-reset';
    showAppModal({eyebrow:'Potvrzení časomíry',title:'Vynulovat čas zápasu?',compact:true,body:`
      <div class="confirm-visual"><div class="confirm-icon danger">0:00</div><div class="confirm-copy"><h3>Vrátit zápas na začátek</h3><p>Zařízení zastaví čas, nastaví 0:00 a zruší poločas i koncový odpočet. Skóre zůstane beze změny.</p></div></div>`,
      footer:`<button onclick="closeAppModal()">Zrušit</button><button class="modal-confirm danger" onclick="confirmClockReset()">Vynulovat čas</button>`});
  }
  function confirmClockReset(){ cmd('clock_reset'); closeAppModal(); }

  function openDeviceOffModal(){
    activeModalView='confirm-device-off';
    showAppModal({eyebrow:'Vzdálené ovládání',title:'Vypnout zařízení?',compact:true,body:`
      <div class="confirm-visual"><div class="confirm-icon danger">OFF</div><div class="confirm-copy"><h3>Přejít do soft OFF režimu</h3><p>RF příkazy a čas se zastaví. LTE a MQTT zůstanou aktivní, aby bylo možné zařízení z tohoto panelu znovu zapnout.</p></div></div>`,
      footer:`<button onclick="closeAppModal()">Zrušit</button><button class="modal-confirm danger" onclick="confirmDeviceOff()">Vypnout zařízení</button>`});
  }
  function confirmDeviceOff(){ cmd('device_off'); closeAppModal(); }

  function openRestartModal(){
    activeModalView='confirm-restart';
    showAppModal({eyebrow:'Systémový příkaz',title:'Restartovat zařízení?',compact:true,body:`
      <div class="confirm-visual"><div class="confirm-icon danger">!</div><div class="confirm-copy"><h3>Zařízení se krátce odpojí</h3><p>Restart ukončí aktuální spojení a zařízení se musí znovu připojit k mobilní síti a MQTT brokeru.</p></div></div>`,
      footer:`<button onclick="closeAppModal()">Zrušit</button><button class="modal-confirm danger" onclick="confirmDeviceRestart()">Restartovat</button>`});
  }
  function confirmDeviceRestart(){ cmd('reboot'); closeAppModal(); }

  document.querySelectorAll('[data-modal-view]').forEach(link=>link.addEventListener('click',event=>{
    event.preventDefault();
    document.querySelectorAll('.side-link').forEach(item=>item.classList.remove('active'));
    link.classList.add('active');
    openPanelModal(link.dataset.modalView);
  }));
  $('appModalClose').addEventListener('click',closeAppModal);
  $('appModal').addEventListener('click',event=>{ if(event.target===$('appModal')) closeAppModal(); });
  document.addEventListener('keydown',event=>{
    if(!$('appModal').classList.contains('open')) return;
    if(event.key==='Escape') return closeAppModal();
    if(event.key!=='Tab') return;
    const focusable=[...$('appModalDialog').querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter(element=>!element.disabled&&element.offsetParent!==null);
    if(!focusable.length) return;
    const first=focusable[0],last=focusable[focusable.length-1];
    if(event.shiftKey&&document.activeElement===first){ event.preventDefault(); last.focus(); }
    else if(!event.shiftKey&&document.activeElement===last){ event.preventDefault(); first.focus(); }
  });

  window.ScoreBridgeAdmin=Object.freeze({
    deviceId:DEVICE_ID,
    topics:Object.freeze({
      command:T_CMD,status:T_STATUS,event:T_EVENT,
      learnCommand:T_LEARN_CMD,learnStatus:T_LEARN_STATUS,learnSample:T_LEARN_SAMPLE,
      profileCommand:T_PROFILE_CMD,profileStatus:T_PROFILE_STATUS,
      profileChunk:T_PROFILE_CHUNK,profileData:T_PROFILE_DATA
    }),
    isConnected:()=>client.connected,
    publish:(topic,payload,options={})=>{
      if(!client.connected){ log('Nejsem připojen k brokeru'); return false; }
      client.publish(topic,payload,{qos:0,retain:false,...options,retain:false});
      return true;
    },
    publishJson:(topic,payload)=>{
      if(!client.connected){ log('Nejsem připojen k brokeru'); return false; }
      let serialized;
      try{ serialized=JSON.stringify(payload); }catch(error){ log('Nelze vytvořit JSON: '+error.message); return false; }
      client.publish(topic,serialized,{qos:0,retain:false});
      return true;
    },
    onMqttMessage:listener=>{ mqttExtensionListeners.add(listener); return ()=>mqttExtensionListeners.delete(listener); },
    onConnection:listener=>{
      mqttConnectionListeners.add(listener);
      try{ listener(client.connected); }catch(error){ log('Chyba doplňku: '+error.message); }
      return ()=>mqttConnectionListeners.delete(listener);
    },
    log,
    showModal:showAppModal,
    closeModal:closeAppModal,
    setModalView:view=>{ activeModalView=view; },
    getModalView:()=>activeModalView
  });
