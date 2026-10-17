// Shares the existing BGM AudioContext. Mic never enters preview/monitor media.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.InternalAudio=api})(globalThis,function(){
  const virtual=/voicemeeter|cable|stereo mix|立体声混音|loopback|steam streaming/i;
  const alias=id=>!id||['default','communications'].includes(id);
  function validate({mic,cable,monitor}){
    if(!mic||alias(mic.deviceId)||virtual.test(mic.label))throw Error('请选择真实麦克风，不要使用虚拟录音设备或系统默认项。');
    if(!cable||alias(cable.deviceId)||!/^CABLE(?:-[A-D])? Input\b/i.test(cable.label))throw Error('未找到 CABLE Input。请安装 VB-CABLE 并重启，不会回退到系统默认输出。');
    if(!monitor||alias(monitor.deviceId)||virtual.test(monitor.label))throw Error('请选择真实耳机作为音乐监听。');
  }
  class Route {
    constructor(context,musicGain,onFailure=()=>{}){
      this.context=context;this.musicGain=musicGain;this.onFailure=onFailure;
      this.generation=0;this.running=false;this.stream=null;this.muted=false;this.gainDb=0;
    }
    async connect(devices){
      validate(devices);
      if(this.running){if(['mic','cable','monitor'].every(k=>this.devices[k].deviceId===devices[k].deviceId))return true;throw Error('请先断开麦克风，再切换设备。')}
      const ticket=++this.generation;let stream;
      try{
        if(typeof this.context.setSinkId!=='function')throw Error('当前音频引擎不支持指定混合输出，请使用配套的新版 LBGM 程序。');
        await this.context.setSinkId(devices.cable.deviceId);
        if(!this.workletReady)this.workletReady=this.context.audioWorklet.addModule(new URL('peak-guard.js',location.href).href).catch(error=>{this.workletReady=null;throw error});
        await this.workletReady;
        if(ticket!==this.generation)return false;
        stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:devices.mic.deviceId},echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:1},sampleRate:{ideal:48000}}});
        if(ticket!==this.generation){stream.getTracks().forEach(t=>t.stop());return false}
        if(!this.mix){
          this.mix=this.context.createGain();this.guard=new AudioWorkletNode(this.context,'lbgm-peak-guard',{outputChannelCount:[2]});
          this.micMeter=this.context.createAnalyser();this.mixMeter=this.context.createAnalyser();this.musicMeter=this.context.createAnalyser();
          for(const meter of [this.micMeter,this.mixMeter,this.musicMeter])meter.fftSize=2048;
        }
        this.micGain=this.context.createGain();this.micGain.gain.value=this.muted?0:10**(this.gainDb/20);this.micSource=this.context.createMediaStreamSource(stream);
        this.musicGain.connect(this.mix);this.musicGain.connect(this.musicMeter);
        this.mix.connect(this.guard);this.guard.connect(this.context.destination);this.guard.connect(this.mixMeter);
        this.micSource.connect(this.micGain);this.micGain.connect(this.mix);this.micGain.connect(this.micMeter);
        this.stream=stream;this.devices=devices;this.running=true;this.setGain(this.gainDb);
        const fail=message=>{if(ticket===this.generation&&this.running){this.stop();this.onFailure(message)}};
        for(const track of stream.getTracks())track.addEventListener('ended',()=>fail('麦克风已断开。请检查连接后重新开启麦克风。'));
        this.stateListener=()=>{if(this.context.state!=='running')fail('混音引擎已暂停，可能由休眠或设备变化引起。请重新连接。')};
        await this.context.resume();
        if(ticket!==this.generation){if(this.stream===stream)this.stop();return false}
        this.context.addEventListener('statechange',this.stateListener);return true;
      }catch(error){stream?.getTracks().forEach(t=>t.stop());if(ticket===this.generation)this.stop();throw error}
    }
    setGain(db){
      if(!Number.isFinite(db)||db< -24||db>12)throw Error('麦克风增益应在 −24 至 +12 dB 之间。');
      this.gainDb=db;if(this.micGain)this.micGain.gain.setTargetAtTime(this.muted?0:10**(db/20),this.context.currentTime,0.015);
    }
    setMuted(muted){this.muted=Boolean(muted);this.setGain(this.gainDb)}
    stop(){
      ++this.generation;this.running=false;
      this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;
      if(this.stateListener)this.context.removeEventListener('statechange',this.stateListener);this.stateListener=null;
      this.micSource?.disconnect();this.micGain?.disconnect();this.micGain=null;this.micSource=null;
      if(this.mix){try{this.musicGain.disconnect(this.mix)}catch{}try{this.musicGain.disconnect(this.musicMeter)}catch{}this.mix.disconnect();this.guard.disconnect()}
    }
    levels(){
      if(!this.meterBuffers)this.meterBuffers=new WeakMap();
      const peak=meter=>{if(!this.running)return 0;let data=this.meterBuffers.get(meter);if(!data||data.length!==meter.fftSize){data=new Float32Array(meter.fftSize);this.meterBuffers.set(meter,data)}meter.getFloatTimeDomainData(data);let p=0;for(const v of data)p=Math.max(p,Math.abs(v));return p};
      return {mic:peak(this.micMeter),music:peak(this.musicMeter),mix:peak(this.mixMeter)};
    }
    diagnostics(levels){return {running:this.running,muted:this.muted,gainDb:this.gainDb,sampleRate:this.context.sampleRate,contextState:this.context.state,sinkId:this.context.sinkId,baseLatencyMs:this.context.baseLatency*1000,outputLatencyMs:(this.context.outputLatency||0)*1000,captureSettings:this.stream?.getAudioTracks()[0]?.getSettings()||{},levels:levels||(this.running?this.levels():{mic:0,music:0,mix:0})}}
  }
  return {Route,validate,isVirtual:label=>virtual.test(label),isAlias:alias};
});
