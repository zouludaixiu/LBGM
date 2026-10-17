// Full-band stereo protection; no EQ, denoising or voice processing.
class PeakGuard extends AudioWorkletProcessor {
  constructor(){super();this.gain=1;this.release=1-Math.exp(-1/(sampleRate*0.08));}
  process(inputs,outputs){
    const input=inputs[0],output=outputs[0];
    if(!input.length){for(const channel of output)channel.fill(0);return true}
    for(let i=0;i<output[0].length;i++){
      let peak=0;for(const channel of input)peak=Math.max(peak,Math.abs(channel[i]||0));
      const desired=peak>0.89?0.89/peak:1;
      this.gain=desired<this.gain?desired:this.gain+(desired-this.gain)*this.release;
      for(let c=0;c<output.length;c++)output[c][i]=(input[c%input.length][i]||0)*this.gain;
    }
    return true;
  }
}
registerProcessor('lbgm-peak-guard',PeakGuard);
