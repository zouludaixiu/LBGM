const $=id=>document.getElementById(id);
const engine=new PrototypeMixer.Mixer($('music'),$('monitorAudio'),message=>{status(message,true);renderConnection()});
let config={},devices=[],connecting=false,micMuted=false,toneSource=null,lastReport={},refreshing=false;
const tracks=[null,null,null];
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error)}
function renderConnection(){const live=engine.running;$('connection').textContent=live?'麦克风持续传输':'未连接';$('connection').classList.toggle('live',live);$('connect').disabled=connecting;for(const id of ['mic','cable','monitor'])$(id).disabled=live||connecting;$('disconnect').disabled=!live&&!connecting;$('muteMic').textContent=micMuted?'取消麦克风静音':'麦克风静音'}
async function save(){config={...config,micId:$('mic').value,cableId:$('cable').value,monitorId:$('monitor').value,micLabel:$('mic').selectedOptions[0]?.textContent,cableLabel:$('cable').selectedOptions[0]?.textContent,monitorLabel:$('monitor').selectedOptions[0]?.textContent,micGainDb:Number($('micGain').value),musicVolume:Number($('musicVolume').value)/100,monitorVolume:Number($('monitorVolume').value)/100,tracks};await window.mixerPrototype.save(config)}
function withTimeout(promise,ms,message){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms)})]).finally(()=>clearTimeout(timer))}
function chooseOptions(id,list,savedId,savedLabel){const select=$(id);const previous=select.value;select.replaceChildren(new Option('请选择设备',''));for(const d of list)select.add(new Option(d.label,d.deviceId));select.value=list.find(d=>d.deviceId===previous)?.deviceId||list.find(d=>d.deviceId===savedId)?.deviceId||list.find(d=>d.label===savedLabel)?.deviceId||list[0]?.deviceId||''}
async function refresh(authorize=false){
  if(refreshing)return;refreshing=true;$('refresh').disabled=true;
  try{
    if(authorize){const promise=navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(t=>t.stop());return stream});await withTimeout(promise,10000,'麦克风授权等待超时，请检查 Windows 隐私权限。')}
    devices=await withTimeout(navigator.mediaDevices.enumerateDevices(),5000,'读取音频设备超时。');
    const unique=list=>[...new Map(list.filter(d=>!PrototypeMixer.isAlias(d.deviceId)).map(d=>[d.label,d])).values()];
    const inputs=unique(devices.filter(d=>d.kind==='audioinput'&&d.label&&!PrototypeMixer.isVirtual(d.label)));
    const outputs=unique(devices.filter(d=>d.kind==='audiooutput'&&d.label));
    chooseOptions('mic',inputs,config.micId,config.micLabel);chooseOptions('cable',outputs.filter(d=>/^CABLE(?:-[A-D])? Input\b/i.test(d.label)),config.cableId,config.cableLabel);chooseOptions('monitor',outputs.filter(d=>!PrototypeMixer.isVirtual(d.label)),config.monitorId,config.monitorLabel);
    $('deviceHint').textContent=$('cable').value?'已找到 VB-CABLE；连接后将持续采集所选麦克风。':'未检测到 CABLE Input。请从官网下载 VB-CABLE，管理员安装并重启；不要选 Voicemeeter 代替。';
  }catch(error){status(error.message,true)}finally{refreshing=false;$('refresh').disabled=false;renderConnection()}
}
function volume(){const values={micGainDb:Number($('micGain').value),musicVolume:Number($('musicVolume').value)/100,monitorVolume:Number($('monitorVolume').value)/100};engine.setVolumes(values);if(micMuted&&engine.micGain)engine.micGain.gain.setTargetAtTime(0,engine.context.currentTime,0.015);$('micValue').textContent=values.micGainDb+' dB';$('musicValue').textContent=Math.round(values.musicVolume*100)+'%';$('monitorValue').textContent=Math.round(values.monitorVolume*100)+'%'}
function selection(){const find=id=>devices.find(d=>d.deviceId===$(id).value);return {mic:find('mic'),cable:find('cable'),monitor:find('monitor')}}
async function connect(){
  if(connecting)return;connecting=true;micMuted=false;renderConnection();status('正在连接设备并建立持续混音通路…');
  try{await withTimeout(engine.connect(selection()),12000,'连接音频设备超时，请检查麦克风权限与 VB-CABLE。');if(!engine.running)return;volume();await save();status('已连接。QQ 麦克风请选择 CABLE Output；先说话确认电平，再播放 BGM。')}
  catch(error){await engine.disconnect();status(error.message,true)}finally{connecting=false;renderConnection()}
}
function readTrack(slot){const track=tracks[slot];if(!track)throw Error('请先导入该槽位的音频。');const start=Number($('start'+slot).value||0),text=$('end'+slot).value.trim(),end=text===''?null:Number(text);if(!Number.isFinite(start)||start<0||(end!==null&&(!Number.isFinite(end)||end<=start)))throw Error('开始和结束时间无效。');tracks[slot]={...track,startTime:start,endTime:end};return tracks[slot]}
async function perform(action){try{await action()}catch(error){status(error.message,true)}renderConnection()}
async function play(slot){await engine.play(readTrack(slot),slot);await save();status('BGM 已更新；麦克风保持传输。')}
for(let slot=0;slot<3;slot++){
  const row=document.createElement('div');row.className='slot';row.innerHTML=`<strong>Shift+${slot+1}</strong><span id="name${slot}" class="slot-name">未导入</span><label>开始 / 秒<input id="start${slot}" type="number" min="0" step="0.01" value="0"></label><label>结束 / 秒<input id="end${slot}" type="number" min="0" step="0.01" placeholder="结尾"></label><button id="import${slot}">导入</button><button id="play${slot}">播放 / 暂停</button>`;$('slots').append(row);
  $('import'+slot).onclick=()=>perform(async()=>{const track=await window.mixerPrototype.chooseAudio();if(!track)return;tracks[slot]=track;$('name'+slot).textContent=track.name;$('name'+slot).title=track.name;$('start'+slot).value=0;$('end'+slot).value='';await save()});
  $('play'+slot).onclick=()=>perform(()=>play(slot));for(const prefix of ['start','end'])$(prefix+slot).onchange=()=>perform(async()=>{readTrack(slot);await save()});
}
$('refresh').onclick=()=>refresh(true);$('connect').onclick=connect;
$('disconnect').onclick=()=>perform(async()=>{await engine.disconnect();status('已断开麦克风与音乐。QQ 请切回原来的输入。')});
$('download').onclick=()=>window.mixerPrototype.cableHelp();
for(const id of ['micGain','musicVolume','monitorVolume']){$(id).oninput=()=>perform(async()=>volume());$(id).onchange=()=>perform(save)}
$('muteMic').onclick=()=>{micMuted=!micMuted;volume();renderConnection()};
$('pause').onclick=()=>perform(()=>engine.toggle());$('restart').onclick=()=>perform(()=>engine.restart());
$('tone').onclick=()=>perform(async()=>{if(!engine.running)throw Error('请先连接设备。');toneSource?.stop();const tone=engine.context.createOscillator(),gain=engine.context.createGain();tone.frequency.value=997;gain.gain.value=0;gain.gain.setTargetAtTime(0.04,engine.context.currentTime,0.01);gain.gain.setTargetAtTime(0,engine.context.currentTime+0.85,0.02);tone.connect(gain).connect(engine.mix);tone.start();tone.stop(engine.context.currentTime+1);toneSource=tone;tone.onended=()=>{tone.disconnect();gain.disconnect();if(toneSource===tone)toneSource=null};status('短测试音发送到混合输出，不进入耳机监听；请在 QQ 确认。')});
document.addEventListener('keydown',event=>{if(event.repeat||/INPUT|SELECT|TEXTAREA/.test(event.target.tagName))return;const number=Number(event.code.replace('Digit',''));if(event.shiftKey&&!event.ctrlKey&&number>=1&&number<=3){event.preventDefault();perform(()=>play(number-1))}else if(event.ctrlKey&&!event.shiftKey&&event.code==='KeyA'){event.preventDefault();perform(()=>engine.toggle())}else if(event.ctrlKey&&!event.shiftKey&&event.code==='Digit4'){event.preventDefault();perform(()=>engine.restart())}});
setInterval(()=>{
  const levels=engine.levels();for(const kind of ['mic','music','mix']){const peak=levels[kind];$(kind+'Meter').value=peak;$(kind+'Db').textContent=peak>0.00001?(20*Math.log10(peak)).toFixed(1)+' dBFS':'−∞ dBFS'}
  $('peakHint').textContent=levels.mic>=0.95||levels.music>=0.95?'某一路已接近满幅，请调低麦克风增益或 BGM 音量。峰值保护不能修复采集前的失真。':'混合输出保留峰值余量；建议先从 0 dB 麦克风增益开始。';
  $('peakHint').classList.toggle('error',levels.mic>=0.95||levels.music>=0.95);
  const d=engine.diagnostics();$('latency').textContent=engine.running?`引擎 ${d.contextState} · ${d.sampleRate} Hz · 基础延迟 ${d.baseLatencyMs.toFixed(1)} ms · 输出延迟 ${d.outputLatencyMs.toFixed(1)} ms`:'尚未连接';
  $('playing').textContent=engine.current?`${engine.current.track.name} · ${engine.finished?'片段结束':engine.music.paused?'BGM 暂停':'播放中'} · ${engine.music.currentTime.toFixed(1)} 秒`:'尚未播放 BGM';
},200);
navigator.mediaDevices.addEventListener('devicechange',()=>perform(async()=>{const current=await navigator.mediaDevices.enumerateDevices();if(engine.running){const ids=[engine.devices.mic.deviceId,engine.devices.cable.deviceId,engine.devices.monitor.deviceId];if(ids.some(id=>!current.some(d=>d.deviceId===id))){await engine.disconnect();status('所选设备已消失，停止输出以避免误路由。重新选择设备并连接。',true)}}if(!engine.running)await refresh()}));
$('copyReport').onclick=()=>perform(async()=>{lastReport={prototype:'phase-1',time:new Date().toISOString(),...engine.diagnostics(),micMuted};const text=JSON.stringify(lastReport,null,2);$('report').textContent=text;$('report').hidden=false;await navigator.clipboard.writeText(text);status('诊断已复制。包含设备标识，发送给他人前请检查隐私信息。')});
window.addEventListener('beforeunload',()=>{engine.stream?.getTracks().forEach(t=>t.stop());engine.pauseMusic()});
(async()=>{config=await window.mixerPrototype.settings();for(const [id,key,multiplier]of [['micGain','micGainDb',1],['musicVolume','musicVolume',100],['monitorVolume','monitorVolume',100]])if(Number.isFinite(config[key]))$(id).value=config[key]*multiplier;for(let slot=0;slot<3;slot++){tracks[slot]=config.tracks?.[slot]||null;if(tracks[slot]){$('name'+slot).textContent=tracks[slot].name;$('start'+slot).value=tracks[slot].startTime??0;$('end'+slot).value=tracks[slot].endTime??''}}volume();await refresh();renderConnection()})().catch(error=>status(error.message,true));
