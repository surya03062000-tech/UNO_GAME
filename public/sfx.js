// Tiny WebAudio sound-effects engine — generates beeps on the fly, no audio files.
const SFX = (() => {
  let ctx = null;
  let enabled = localStorage.getItem("uno_sfx") !== "off";

  const ensure = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };

  // Play a short tone (or a sequence of {f, t, type} steps).
  function tone(steps) {
    if (!enabled) return;
    const ac = ensure();
    let when = ac.currentTime;
    steps.forEach(({ f, t = 0.12, type = "sine", g = 0.18 }) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f, when);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(g, when + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + t);
      osc.connect(gain).connect(ac.destination);
      osc.start(when);
      osc.stop(when + t + 0.02);
      when += t;
    });
  }

  const sounds = {
    play:    () => tone([{ f: 520, t: 0.08, type: "triangle" }]),
    number:  () => tone([{ f: 480, t: 0.07, type: "triangle" }]),
    draw:    () => tone([{ f: 300, t: 0.1, type: "sine" }, { f: 220, t: 0.1, type: "sine" }]),
    skip:    () => tone([{ f: 700, t: 0.06, type: "square", g: 0.12 }, { f: 400, t: 0.1, type: "square", g: 0.12 }]),
    reverse: () => tone([{ f: 400, t: 0.08, type: "sawtooth" }, { f: 600, t: 0.08, type: "sawtooth" }]),
    wild:    () => tone([{ f: 520, t: 0.07 }, { f: 660, t: 0.07 }, { f: 820, t: 0.09 }]),
    drawbig: () => tone([{ f: 240, t: 0.09, type: "sawtooth", g: 0.2 }, { f: 180, t: 0.12, type: "sawtooth", g: 0.2 }]),
    uno:     () => tone([{ f: 880, t: 0.1, type: "square" }, { f: 1100, t: 0.12, type: "square" }]),
    turn:    () => tone([{ f: 660, t: 0.08, type: "sine" }, { f: 990, t: 0.1, type: "sine" }]),
    win:     () => tone([{ f: 523, t: 0.12 }, { f: 659, t: 0.12 }, { f: 784, t: 0.12 }, { f: 1046, t: 0.2 }]),
    lose:    () => tone([{ f: 400, t: 0.15, type: "sawtooth" }, { f: 250, t: 0.25, type: "sawtooth" }]),
    error:   () => tone([{ f: 200, t: 0.12, type: "square", g: 0.12 }]),
    eliminate: () => tone([{ f: 300, t: 0.1, type: "sawtooth" }, { f: 150, t: 0.2, type: "sawtooth" }]),
  };

  // Pick the right sound for a played card.
  function forCard(card) {
    if (!card) return;
    const k = card.kind;
    if (k === "number") return sounds.number();
    if (k === "skip" || k === "skipAll") return sounds.skip();
    if (k === "reverse") return sounds.reverse();
    if (k === "draw2") return sounds.draw();
    if (["draw6", "draw8", "draw10", "wild4"].includes(k)) return sounds.drawbig();
    if (k === "wild") return sounds.wild();
    return sounds.play();
  }

  return {
    isOn: () => enabled,
    toggle() {
      enabled = !enabled;
      localStorage.setItem("uno_sfx", enabled ? "on" : "off");
      if (enabled) ensure() && sounds.play();
      return enabled;
    },
    forCard,
    play: (name) => sounds[name] && sounds[name](),
    unlock: () => { try { ensure(); } catch {} },
  };
})();
window.SFX = SFX;
