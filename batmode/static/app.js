import { Sculpture } from './scene.js';

const $=id=>document.getElementById(id);
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const stage=$('stage'), video=$('video'), sculpture=new Sculpture($('scene'));
let state={phase:'idle',running:false,bins:[],velocity:0,probe:false}, connected=false, busy=false;
let preview=false, position=.32, scene='bloom', gain=1, duration=10, lastFrame=performance.now(), lastDraw=-1, lastScene='';
let drag=null, keyboardDirection=0, lastStateAt=0, videoURL=null, filmLoaded=false, seekAt=0, previousPhase='';
let history=[], toastTimer, latestSpectrum=[], drawSpectrumAt=0;
const sceneNames={bloom:['KINETIC STUDY / 001','The bloom.','One movement. A thousand possibilities.'],orbit:['KINETIC STUDY / 002','In orbit.','A small universe, at your fingertips.'],film:['ORIGINAL FILM / 003','Time, reversed.','Push it apart. Pull it back together.'],video:['YOUR LOCAL VIDEO','Your moment.','A new way to move through a familiar scene.']};

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
async function command(path,body={}){
  const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'The local server could not complete this action.');return data;
}
function timecode(seconds){return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toFixed(2).padStart(5,'0')}`;}
function setPosition(value){position=clamp(value,0,1);$('timeline').value=position;$('time-current').textContent=timecode(position*duration);$('time-duration').textContent=timecode(duration);}
function setScene(name){
  scene=name;lastDraw=-1;duration=(name==='video'||name==='film')&&Number.isFinite(video.duration)?video.duration:10;
  $('scene').hidden=name==='video'||name==='film';video.hidden=!$('scene').hidden;
  const copy=sceneNames[name];$('scene-caption').textContent=copy[0];$('scene-title').textContent=copy[1];$('scene-subtitle').textContent=copy[2];
  document.querySelectorAll('[data-scene]').forEach(button=>{const active=button.dataset.scene===name;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  setPosition(position);
}
function selectFilm(){
  if(videoURL){URL.revokeObjectURL(videoURL);videoURL=null;}
  filmLoaded=true;video.src='/bloom.mp4';video.load();setScene('film');
}
function showState(){
  const phase=state.phase, active=state.running;
  const titles={idle:'Meet your sixth sense.',starting:'Waking up your sonar.',scanning:'Finding your frequency.',baseline:'Learning the quiet.',toward:'Push toward the screen.',away:'Now, pull your hand back.',ready:'You’re in control.',probe_off:'Silence the source.',error:'Let’s adjust the setup.'};
  $('status-title').textContent=preview?'Take time for a spin.':titles[phase]||'Listening…';
  let message=phase==='idle'?'Your laptop sends a high-frequency tone and listens for changes as your hand moves.':state.message;
  $('status-message').textContent=preview?'Drag left or right across the scene. You can also use the arrow keys. Start sonar when you’re ready.':message;
  const start=$('start');start.disabled=busy||!connected;start.classList.toggle('stopping',active);
  start.firstElementChild.textContent=active?'Stop sonar':phase==='error'?'Try again':'Start sonar';start.lastElementChild.textContent=active?'■':'↗';
  $('preview').textContent=preview?'Exit mouse preview':'Explore with your mouse';$('preview').disabled=busy;
  $('preview-banner').hidden=!preview;$('mode-badge').className='mode-badge'+(preview?' preview':active?' live':'');
  $('mode-badge').textContent=preview?'MOUSE PREVIEW':phase==='ready'?'LIVE SONAR':phase==='probe_off'?'PROBE OFF':active?'CALIBRATING':'AWAITING INPUT';
  $('timeline').disabled=active&&!preview;
  const calibrating=['starting','scanning','baseline','toward','away'].includes(phase);
  $('calibration-progress').hidden=!calibrating;
  $('calibration-fill').style.width=`${Math.round((state.progress||0)*100)}%`;
  $('calibration-step').textContent={starting:'Opening audio',scanning:'01 / Find a clear probe',baseline:'02 / Learn the room',toward:'03 / Check forward motion',away:'04 / Check backward motion'}[phase]||'';
  $('skip-check').hidden=!['toward','away'].includes(phase);
  $('recalibrate').disabled=!active||calibrating;
  $('input-device').disabled=active;$('output-device').disabled=active;$('level').disabled=active;
  $('probe-toggle').disabled=!['ready','probe_off'].includes(phase);
  $('probe-toggle').setAttribute('aria-pressed',String(Boolean(state.probe)));
  $('probe-label').textContent=state.probe?'Probe on':'Probe off';
  $('frequency-label').textContent=active?`${(state.frequency/1000).toFixed(3)} kHz · LISTENING LOCALLY`:'SOUND BECOMES A SENSOR';
  document.querySelector('.sonar-symbol').classList.toggle('listening',active);
  $('carrier-label').textContent=active?`${(state.frequency/1000).toFixed(3)} kHz`:'CARRIER';
  $('snr').replaceChildren(document.createTextNode(active?`${Math.round(state.snr_db||0)} `:'— '),Object.assign(document.createElement('small'),{textContent:'dB'}));
  $('direction-stat').textContent=active?({toward:'Toward ↗',away:'Away ↙',still:'Still'}[state.direction]||'Still'):'—';
  $('verified-stat').textContent=state.verified?'Both directions ✓':phase==='ready'||phase==='probe_off'?'Unverified':active?'Checking…':'Not run';
  if(active&&!state.signal_ok&&!calibrating&&state.probe){$('status-title').textContent='The signal needs a hand.';$('status-message').textContent=state.clipped?'Microphone is clipping. Reduce the probe or system volume, then recalibrate.':'The probe is weak. Check built-in speakers, system volume, and Standard mic mode.';}
  $('evidence-description').textContent=active?(state.probe?'The center is the emitted tone. Reflections shift right as you push, left as you pull.':'The tone is off. The spectrum still shows the microphone; time control is paused.'):'Real frequency measurements appear here when sonar starts. Movement shifts the reflected tone.';
  if(previousPhase!==phase){previousPhase=phase;if(phase==='ready'&&state.verified)toast('Both directions detected. Your hand now controls time.');}
}

async function loadDevices(){
  try{const response=await fetch('/api/devices');const data=await response.json();if(!response.ok)throw Error(data.error);for(const [key,field,selected] of [['inputs','input-device',data.default_input],['outputs','output-device',data.default_output]]){$(field).replaceChildren(...data[key].map(device=>{const option=document.createElement('option');option.value=device.id;option.textContent=device.name;option.selected=device.id===selected;return option;}));}}catch(error){toast(`Audio devices unavailable: ${error.message}`);}
}

$('start').addEventListener('click',async()=>{
  if(busy)return;busy=true;preview=false;keyboardDirection=0;drag=null;showState();
  try{state=await command(state.running?'stop':'start',{input_device:Number($('input-device').value),output_device:Number($('output-device').value),level:Number($('level').value)});}catch(error){toast(error.message);state={...state,phase:'error',running:false,message:error.message};}finally{busy=false;showState();}
});
$('preview').addEventListener('click',async()=>{
  if(busy)return;busy=true;
  try{if(state.running)state=await command('stop');preview=!preview;keyboardDirection=0;drag=null;if(preview){stage.focus({preventScroll:true});toast('Drag across the scene, or use ← and →. This is a mouse preview.');}}catch(error){toast(error.message);}finally{busy=false;showState();}
});
$('skip-check').addEventListener('click',()=>command('settings',{skip_check:true}).catch(error=>toast(error.message)));
$('recalibrate').addEventListener('click',()=>command('settings',{recalibrate:true}).catch(error=>toast(error.message)));
$('probe-toggle').addEventListener('click',()=>command('settings',{probe:!state.probe}).catch(error=>toast(error.message)));
$('sensitivity').addEventListener('input',event=>{$('sensitivity-value').textContent=`${event.target.value} dB`;});
$('sensitivity').addEventListener('change',event=>command('settings',{sensitivity:Number(event.target.value)}).catch(error=>toast(error.message)));
$('level').addEventListener('input',event=>{$('level-value').textContent=`${Math.round(event.target.value*100)}%`;});
$('scrub-gain').addEventListener('input',event=>{gain=Number(event.target.value);$('gain-value').textContent=`${gain}×`;});
$('timeline').addEventListener('input',event=>{setPosition(Number(event.target.value));});
$('reset-time').addEventListener('click',()=>{setPosition(.32);toast('Returned to the opening moment.');});
document.querySelectorAll('[data-scene]').forEach(button=>button.addEventListener('click',()=>button.dataset.scene==='film'?selectFilm():setScene(button.dataset.scene)));
$('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.querySelector('.stage-panel').requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser.');}});
$('about-button').addEventListener('click',()=>$('about-dialog').showModal());
document.querySelector('.dialog-close').addEventListener('click',()=>$('about-dialog').close());
$('about-dialog').addEventListener('click',event=>{if(event.target===$('about-dialog')){const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)event.target.close();}});

function loadVideo(file){
  if(!file||(!file.type.startsWith('video/')&&!/\.(mp4|webm|mov|m4v)$/i.test(file.name))){toast('Choose an MP4, WebM, or another browser-supported video.');return;}
  if(videoURL)URL.revokeObjectURL(videoURL);videoURL=URL.createObjectURL(file);filmLoaded=false;video.src=videoURL;video.load();setScene('video');$('scene-title').textContent=file.name.length>32?file.name.slice(0,29)+'…':file.name;setPosition(.32);toast('Video loaded locally. No upload.');
}
$('video-file').addEventListener('change',event=>{loadVideo(event.target.files[0]);event.target.value='';});
video.addEventListener('loadedmetadata',()=>{if(!Number.isFinite(video.duration)||video.duration<=0){toast('This video has no seekable timeline. Try a local MP4.');setScene('bloom');return;}duration=video.duration;setPosition(position);});
video.addEventListener('error',()=>{toast(filmLoaded?'The bundled film could not load. Bloom is available immediately.':'This browser cannot decode that video. Try H.264 MP4 or WebM.');setScene('bloom');});
stage.addEventListener('dragover',event=>{event.preventDefault();$('drop-hint').hidden=false;});
stage.addEventListener('dragleave',event=>{if(!stage.contains(event.relatedTarget))$('drop-hint').hidden=true;});
stage.addEventListener('drop',event=>{event.preventDefault();$('drop-hint').hidden=true;loadVideo(event.dataTransfer.files[0]);});
stage.tabIndex=0;
stage.addEventListener('pointerdown',event=>{if(!preview)return;drag={x:event.clientX,position};stage.setPointerCapture(event.pointerId);stage.focus({preventScroll:true});});
stage.addEventListener('pointermove',event=>{if(preview&&drag)setPosition(drag.position+(event.clientX-drag.x)/stage.clientWidth);});
stage.addEventListener('pointerup',()=>{drag=null;});stage.addEventListener('pointercancel',()=>{drag=null;});
stage.addEventListener('keydown',event=>{if(preview&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();keyboardDirection=event.key==='ArrowLeft'?-1:1;}});
window.addEventListener('keyup',()=>{keyboardDirection=0;});window.addEventListener('blur',()=>{keyboardDirection=0;drag=null;});
window.addEventListener('resize',()=>{lastDraw=-1;drawSpectrumAt=0;});
document.addEventListener('fullscreenchange',()=>{lastDraw=-1;});
document.addEventListener('visibilitychange',()=>{if(document.hidden){keyboardDirection=0;drag=null;if(state.running)command('stop').catch(()=>{});}});
window.addEventListener('pagehide',()=>{if(state.running)fetch('/api/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(()=>{});});
$('export').addEventListener('click',()=>{
  const payload={application:'Bat Mode 0.1.0',created_at:new Date().toISOString(),note:'Derived spectra and motion only. No raw microphone recording. No camera data. No upload.',settings:{input:state.input_name,output:state.output_name,frequency:state.frequency,sensitivity:state.sensitivity,level:Number($('level').value)},verified:state.verified,history};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='bat-mode-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Diagnostics saved. No raw audio included.');
});

const source=new EventSource('/api/events');
source.onmessage=event=>{try{state=JSON.parse(event.data);connected=true;lastStateAt=performance.now();$('connection-state').innerHTML='<span class="tiny-dot"></span> Connected';if(state.running){latestSpectrum=state.bins||[];if(!history.length||Date.now()-history.at(-1).at>100){history.push({at:Date.now(),phase:state.phase,snr:state.snr_db,velocity:state.velocity,lower:state.lower,upper:state.upper,bins:state.bins});if(history.length>600)history.shift();}}else latestSpectrum=[];showState();}catch(error){console.error(error);}};
source.onerror=()=>{connected=false;state={...state,running:false,velocity:0,probe:false,phase:'error',message:'The local server disconnected. Keep the launcher running, then refresh this page.'};latestSpectrum=[];$('connection-state').textContent='Disconnected';showState();};
setInterval(()=>{if(connected&&state.running)command('heartbeat').catch(()=>{});},2000);

function drawSpectrum(){
  const canvas=$('spectrum'),ctx=canvas.getContext('2d'),w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(devicePixelRatio||1,2);
  if(canvas.width!==w*dpr||canvas.height!==h*dpr){canvas.width=w*dpr;canvas.height=h*dpr;}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='#dce4d230';ctx.lineWidth=1;
  for(let i=1;i<5;i++){ctx.beginPath();ctx.moveTo(0,h*i/5);ctx.lineTo(w,h*i/5);ctx.stroke();}
  ctx.strokeStyle='#bdcbb055';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(w/2,0);ctx.lineTo(w/2,h);ctx.stroke();ctx.setLineDash([]);
  if(!latestSpectrum.length){ctx.font='9px ui-monospace, monospace';ctx.fillStyle='#a1ad94';ctx.textAlign='center';ctx.fillText(preview?'NO SYNTHETIC SIGNAL · SONAR OFF':'WAITING FOR MICROPHONE',w/2,h*.6);return;}
  const n=latestSpectrum.length, points=latestSpectrum.map((v,i)=>[i/(n-1)*w,h-clamp((v+85)/85,0,1)*(h-12)]);
  const fill=ctx.createLinearGradient(0,0,0,h);fill.addColorStop(0,'#8aa65f48');fill.addColorStop(1,'#8aa65f02');
  ctx.beginPath();ctx.moveTo(0,h);for(const p of points)ctx.lineTo(...p);ctx.lineTo(w,h);ctx.closePath();ctx.fillStyle=fill;ctx.fill();
  ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.strokeStyle='#8aa465';ctx.lineWidth=1.3;ctx.stroke();
}
function animate(now){
  const dt=Math.min((now-lastFrame)/1000,.06);lastFrame=now;
  const fresh=now-lastStateAt<500;
  const velocity=preview?keyboardDirection:(connected&&fresh&&state.phase==='ready'&&state.signal_ok?state.velocity:0);
  if(velocity)setPosition(position+velocity*gain*dt*.16);
  if(scene==='video'||scene==='film'){
    const target=position*duration;
    if(video.readyState>=2&&!video.seeking&&now-seekAt>35&&Math.abs(video.currentTime-target)>.025){video.currentTime=clamp(target,0,Math.max(0,duration-.035));seekAt=now;}
  }else if(lastDraw!==position||lastScene!==scene){sculpture.draw(position,scene);lastDraw=position;lastScene=scene;}
  const moving=Math.abs(velocity)>.1;
  $('motion-indicator').classList.toggle('moving',moving);$('motion-arrow').textContent=moving?(velocity>0?'↗':'↙'):'Ⅱ';$('motion-label').textContent=moving?(velocity>0?'FORWARD':'REWIND'):'FROZEN';
  $('stage-kicker').textContent=preview?'MOUSE-CONTROLLED PREVIEW':moving?'TIME FOLLOWS YOUR HAND':'SUSPENDED IN TIME';
  if(now-drawSpectrumAt>66){drawSpectrum();drawSpectrumAt=now;}
  requestAnimationFrame(animate);
}
setPosition(position);showState();loadDevices();requestAnimationFrame(animate);
