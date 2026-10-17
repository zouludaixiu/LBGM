(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PrototypeMixer=api})(globalThis,function(){
  const virtual=/voicemeeter|cable|立体声混音|stereo mix|loopback/i;
  const alias=id=>!id||['default','communications'].includes(id);
  function validateDevices(devices){
    const {mic,cable,monitor}=devices;
    if(!mic||alias(mic.deviceId)||virtual.test(mic.label))throw Error('请选择真实麦克风，不要选择虚拟输入或系统默认项。');
    if(!cable||alias(cable.deviceId)||!/^CABLE(?:-[A-D])? Input\b/i.test(cable.label))throw Error('未找到 VB-CABLE。请选择 CABLE Input，不能使用耳机或 Voicemeeter 替代。');
    if(!monitor||alias(monitor.deviceId)||virtual.test(monitor.label))throw Error('请选择真实耳机或扬声器作为音乐监听。');
  }
  function range(track,duration){
    const start=Number(track.startTime??0),end=track.endTime==null||track.endTime===''?duration:Number(track.endTime);
    if(!Number.isFinite(start)||start<0||!Number.isFinite(end)||end<=start||start>=duration||end>duration+0.02)throw Error('片段时间无效：开始需早于结束，且不能超出音频长度。');
    return {start,end:Math.min(end,duration)};
  }
  function ready(media,url){
    if(media.src===url&&media.readyState>=1)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);media.removeEventListener('loadedmetadata',ok);media.removeEventListener('error',fail);error?reject(error):resolve()};
      const ok=()=>done(),fail=()=>done(Error('无法解码音频，请检查文件是否存在或换用 MP3/WAV。'));
      const timer=setTimeout(()=>done(Error('读取音频超时。')),8000);
      media.addEventListener('loadedmetadata',ok);media.addEventListener('error',fail);media.src=url;media.load();
    });
  }
  class Mixer {
    constructor(music,monitor,onFailure=()=>{}){
      this.music=music;this.monitor=monitor;this.onFailure=onFailure;this.generation=0;this.running=false;this.current=null;this.finished=false;this.busy=false;
      this.volumes={micGainDb:0,musicVolume:0.13,monitorVolume:0.13};
      this.timer=setInterval(()=>this.checkBoundary(),30);
      music.addEventListener('ended',()=>{this.finished=true;this.pauseMusic()});
      this.outputElement=null;
    }
    async connect(devices){
      validateDevices(devices);
      const ticket=++this.generation;
      await this.teardown();
      let stream,context;
      try{
        stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:devices.mic.deviceId},echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:1},sampleRate:{ideal:48000}}});
        if(ticket!==this.generation){stream.getTracks().forEach(t=>t.stop());return false}
        context=new AudioContext({latencyHint:'interactive',sampleRate:48000});
        // No source is connected until the explicit sink has been bound.
        if(typeof context.setSinkId!=='function')throw Error('当前 Electron 缺少 AudioContext 输出绑定能力；原型不会回退到系统默认输出。');
        await context.setSinkId(devices.cable.deviceId);
        await this.monitor.setSinkId(devices.monitor.deviceId);
        await context.audioWorklet.addModule(new URL('limiter-worklet.js',location.href).href);
        if(ticket!==this.generation){stream.getTracks().forEach(t=>t.stop());await context.close();return false}
        this.context=context;this.stream=stream;
        this.micSource=context.createMediaStreamSource(stream);this.micGain=context.createGain();
        this.musicGain=context.createGain();this.mix=context.createGain();
        this.guard=new AudioWorkletNode(context,'lbgm-peak-guard',{outputChannelCount:[2]});
        this.micMeter=context.createAnalyser();this.musicMeter=context.createAnalyser();this.mixMeter=context.createAnalyser();
        for(const meter of [this.micMeter,this.musicMeter,this.mixMeter])meter.fftSize=2048;
        this.micSource.connect(this.micGain);this.micGain.connect(this.mix);this.micGain.connect(this.micMeter);
        this.mix.connect(this.guard);this.guard.connect(this.mixMeter);this.guard.connect(context.destination);
        // A fresh media element is needed when its previous AudioContext closes.
        this.music.removeAttribute('src');this.music.load();
        this.music=this.music.cloneNode();
        this.musicSource=context.createMediaElementSource(this.music);this.musicSource.connect(this.musicGain);this.musicGain.connect(this.mix);this.musicGain.connect(this.musicMeter);
        this.music.addEventListener('ended',()=>{this.finished=true;this.pauseMusic()});
        this.setVolumes(this.volumes);this.running=true;this.devices=devices;
        for(const track of stream.getTracks())track.addEventListener('ended',()=>{if(this.running&&ticket===this.generation)this.fail('麦克风已断开，请重新连接。')});
        context.addEventListener('statechange',()=>{if(this.running&&ticket===this.generation&&context.state!=='running')this.onFailure('音频引擎已暂停，可能由休眠或设备异常引起；请重新连接。')});
        await context.resume();return true;
      }catch(error){stream?.getTracks().forEach(t=>t.stop());if(context&&context.state!=='closed')await context.close().catch(()=>{});if(ticket===this.generation){this.running=false;this.context=null;this.stream=null;this.micGain=null;this.musicGain=null;this.current=null;this.pauseMusic()}throw error}
    }
    setVolumes(values){
      this.volumes={...this.volumes,...values};
      const {micGainDb,musicVolume,monitorVolume}=this.volumes;
      if(!Number.isFinite(micGainDb)||micGainDb< -24||micGainDb>12||![musicVolume,monitorVolume].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('音量超出原型允许范围。');
      if(this.context?.state!=='closed'&&this.micGain){const t=this.context.currentTime;this.micGain.gain.setTargetAtTime(10**(micGainDb/20),t,0.015);this.musicGain.gain.setTargetAtTime(musicVolume,t,0.015)}
      this.monitor.volume=monitorVolume;
    }
    pauseMusic(){this.music.pause();this.monitor.pause()}
    async play(track,slot,restart=false){
      if(!this.running)throw Error('请先连接麦克风与 VB-CABLE。');
      if(this.busy)return;
      this.busy=true;
      try{
        const ticket=this.generation;
        const same=this.current?.slot===slot&&this.current?.track.url===track.url&&this.current?.track.startTime===track.startTime&&this.current?.track.endTime===track.endTime;
        if(same&&!restart&&!this.music.paused){this.pauseMusic();return}
        const reset=restart||!same||this.finished||this.music.ended;
        if(reset){
          this.pauseMusic();await Promise.all([ready(this.music,track.url),ready(this.monitor,track.url)]);
          if(ticket!==this.generation||!this.running)return;
          const selected=range(track,this.music.duration);this.music.currentTime=selected.start;this.monitor.currentTime=selected.start;
          this.current={slot,track:{...track},range:selected};this.finished=false;
        }
        this.monitor.currentTime=this.music.currentTime;
        const results=await Promise.allSettled([this.music.play(),this.monitor.play()]);
        if(ticket!==this.generation||!this.running){this.pauseMusic();return}
        if(results.some(r=>r.status==='rejected')){this.pauseMusic();throw Error('BGM 或耳机监听启动失败；麦克风仍保持连接，请检查设备。')}
      }finally{this.busy=false}
    }
    async toggle(){if(!this.current)throw Error('尚未选择播放音乐。');return this.play(this.current.track,this.current.slot)}
    async restart(){if(!this.current)throw Error('尚未选择播放音乐。');return this.play(this.current.track,this.current.slot,true)}
    checkBoundary(){
      if(!this.running||!this.current||this.music.paused)return;
      if(this.music.currentTime>=this.current.range.end){this.pauseMusic();this.music.currentTime=this.current.range.end;this.monitor.currentTime=this.current.range.end;this.finished=true}
      else if(!this.monitor.paused&&Math.abs(this.monitor.currentTime-this.music.currentTime)>0.12)this.monitor.currentTime=this.music.currentTime;
    }
    levels(){
      const peak=meter=>{if(!this.running||!meter)return 0;const data=new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(data);let p=0;for(const v of data)p=Math.max(p,Math.abs(v));return p};
      return {mic:peak(this.micMeter),music:peak(this.musicMeter),mix:peak(this.mixMeter)};
    }
    async fail(message){await this.disconnect();this.onFailure(message)}
    async teardown(){
      this.running=false;this.pauseMusic();this.current=null;this.finished=false;
      this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;
      const context=this.context;this.context=null;
      if(context&&context.state!=='closed')await context.close();
      this.micGain=null;this.musicGain=null;
    }
    async disconnect(){++this.generation;await this.teardown()}
    async dispose(){clearInterval(this.timer);await this.disconnect()}
    diagnostics(){return {running:this.running,contextState:this.context?.state||'closed',sampleRate:this.context?.sampleRate||null,baseLatencyMs:this.context?.baseLatency*1000||0,outputLatencyMs:this.context?.outputLatency*1000||0,captureSettings:this.stream?.getAudioTracks()[0]?.getSettings()||{},musicPaused:this.music.paused,position:this.music.currentTime,slot:this.current?.slot??null,levels:this.levels()}}
  }
  return {Mixer,validateDevices,range,isVirtual:label=>virtual.test(label),isAlias:alias};
});
