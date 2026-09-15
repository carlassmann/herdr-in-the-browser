const TONES = [
  { frequency: 1046.5, delay: 0, duration: 0.35 },
  { frequency: 1568, delay: 0.09, duration: 0.45 },
];
const PEAK_GAIN = 0.12;

let audio: AudioContext | undefined;

// Browsers only hand out a running AudioContext inside a user gesture, so one
// is opened the first time the session is touched and kept for later pings.
export function unlockNotificationSound(): () => void {
  const unlock = () => {
    audio ??= new AudioContext();
    void audio.resume();
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

export function playNotificationSound(): void {
  if (!audio) return;
  void audio.resume();
  const start = audio.currentTime + 0.01;
  for (const { frequency, delay, duration } of TONES) {
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.frequency.value = frequency;
    envelope.gain.setValueAtTime(0, start + delay);
    envelope.gain.linearRampToValueAtTime(PEAK_GAIN, start + delay + 0.01);
    envelope.gain.exponentialRampToValueAtTime(
      0.0001,
      start + delay + duration,
    );
    oscillator.connect(envelope).connect(audio.destination);
    oscillator.start(start + delay);
    oscillator.stop(start + delay + duration);
  }
}
