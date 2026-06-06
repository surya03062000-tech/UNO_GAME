// WebRTC mesh voice chat. Signaling is relayed by the server (voice:* events).
// Each mic-enabled peer connects to every other mic-enabled peer in the room.
function createVoice(socket) {
  const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };
  const peers = new Map(); // socketId -> { pc, audioEl, name }
  let localStream = null;
  let active = false;
  let muted = false;     // outgoing muted
  let deafened = false;  // incoming muted (audio cut)
  let onStatus = () => {};

  function setStatus(cb) { onStatus = cb; }

  function getPeer(id, name) {
    let p = peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection(ICE);
    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit("voice:signal", { to: id, data: { ice: e.candidate } });
    };
    pc.ontrack = (e) => {
      let el = peers.get(id)?.audioEl;
      if (!el) { el = new Audio(); el.autoplay = true; }
      el.srcObject = e.streams[0];
      el.muted = deafened;
      const rec = peers.get(id);
      if (rec) rec.audioEl = el;
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) removePeer(id);
    };
    p = { pc, audioEl: null, name: name || "Someone" };
    peers.set(id, p);
    return p;
  }

  function removePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch {}
    if (p.audioEl) { p.audioEl.srcObject = null; }
    peers.delete(id);
    onStatus(status());
  }

  async function start(name) {
    if (active) return;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    active = true;
    muted = false;
    socket.emit("voice:join", { name }, async (res) => {
      if (!res || !res.ok) { stop(); return; }
      // We are the initiator toward everyone already in the channel.
      for (const peer of res.peers) {
        const p = getPeer(peer.id, peer.name);
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription(offer);
        socket.emit("voice:signal", { to: peer.id, data: { sdp: p.pc.localDescription } });
      }
      onStatus(status());
    });
  }

  function stop() {
    active = false;
    socket.emit("voice:leave");
    for (const id of [...peers.keys()]) removePeer(id);
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    onStatus(status());
  }

  function toggleMute() {
    muted = !muted;
    if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    onStatus(status());
    return muted;
  }

  function toggleDeafen() {
    deafened = !deafened;
    for (const p of peers.values()) if (p.audioEl) p.audioEl.muted = deafened;
    onStatus(status());
    return deafened;
  }

  function status() { return { active, muted, deafened, count: peers.size }; }

  // ---- Signaling from server ----
  socket.on("voice:peer-joined", ({ id, name }) => {
    // A newcomer arrived; they will send US an offer. Just remember the name.
    if (active && !peers.has(id)) getPeer(id, name);
    onStatus(status());
  });

  socket.on("voice:signal", async ({ from, data }) => {
    if (!active) return;
    const p = getPeer(from);
    if (data.sdp) {
      await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === "offer") {
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        socket.emit("voice:signal", { to: from, data: { sdp: p.pc.localDescription } });
      }
    } else if (data.ice) {
      try { await p.pc.addIceCandidate(new RTCIceCandidate(data.ice)); } catch {}
    }
  });

  socket.on("voice:peer-left", ({ id }) => removePeer(id));

  return { start, stop, toggleMute, toggleDeafen, status, setStatus, isActive: () => active };
}
window.createVoice = createVoice;
