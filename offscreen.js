const SOUNDS = {
  break: { freq: 660, endFreq: 440, duration: 0.35 },
  resume: { freq: 520, endFreq: 780, duration: 0.3 },
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PLAY_SOUND') {
    playChime(SOUNDS[msg.kind] || SOUNDS.break);
  }
});

function playChime({ freq, endFreq, duration }) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + duration);
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration + 0.05);
  osc.onended = () => ctx.close();
}
