"use client";

// P0-6: enhanced recorder used by the session flow. The legacy `Recorder` in
// speaking.tsx stays untouched so existing answer surfaces keep their proven
// recovery behaviour; this component adds the safeguards that only make sense
// for timed session parts:
//   - permission-first mic check with device choice and a 3-second level test
//   - cancelable 3-2-1 countdown and a wake-lock request made in the gesture
//   - auto-stop, last-15s warning, real pause only when MediaRecorder supports it
//   - interruption handling (track ended/mute, recorder error, lost stop)
//   - a take summary with a device-level verdict explicitly labelled as an
//     estimate, audition, re-record and download
// All keyboard paths are available: Space/Enter start (and arm a stop), Esc
// cancels, focus returns to the microphone button after stop/cancel.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import "./speaking.css";

export type MicMode = "idle" | "waiting" | "recording" | "stopping";
export type TakeMeta = {
  durationMs: number;
  /** True only when the level meter actually ran and heard nothing. */
  silent: boolean;
  /** Whether the level meter produced samples at all. */
  metered: boolean;
  incomplete: boolean;
  interrupted: boolean;
};

type Mode = MicMode | "paused";
const MIC_KEY = "bandroom-mic-device";
const PREFERRED = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
const WARN_AT = [30, 10, 3];

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function readStored() {
  try { return localStorage.getItem(MIC_KEY) ?? ""; } catch { return ""; }
}
function writeStored(value: string) {
  try { if (value) localStorage.setItem(MIC_KEY, value); else localStorage.removeItem(MIC_KEY); } catch { /* private mode */ }
}
function supportedType() {
  try {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
    return PREFERRED.find(type => MediaRecorder.isTypeSupported(type)) ?? null;
  } catch { return null; }
}
function micMessage(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限被拒绝。请在浏览器地址栏的站点设置中允许麦克风，然后重试。";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "没有找到可用的麦克风。请连接麦克风，或改用系统默认设备。";
  if (name === "NotReadableError" || name === "AbortError") return "麦克风正被其他程序占用，或系统拒绝访问。关闭占用麦克风的应用后重试。";
  if (name === "microphone_timeout") return "等待麦克风授权超时。请重试，或在浏览器设置中检查麦克风权限。";
  return "麦克风未能开启。请检查浏览器权限，或改用页面外口头练习。";
}
function timeoutError() {
  const error = Error("microphone_timeout");
  error.name = "microphone_timeout";
  return error;
}
function permissionDenied(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError";
}

function LevelBar({ level }: { level: number }) {
  const pct = Math.min(100, Math.round(level * 100));
  return <span className="sp-level" role="meter" aria-label="麦克风电平" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
    <i style={{ width: `${pct}%` }} className={pct < 4 ? "sp-level-low" : ""}/>
  </span>;
}
const wave = [8, 14, 9, 24, 18, 33, 23, 14, 27, 39, 17, 26, 46, 32, 18, 25, 12, 19, 10, 13, 7];
function Wave({ live = false }: { live?: boolean }) {
  return <span className={`sp-wave ${live ? "sp-live" : ""}`} aria-hidden="true">
    {wave.map((height, i) => <i key={i} style={{ height, animationDelay: `${i * -0.067}s` }}/>)}
  </span>;
}

export default function SessionRecorder({ limit, clip, disabled, practice = true, heading, stopRequestRef, onClip, onActive, onDiscard }: {
  limit: number;
  clip: Blob | null;
  disabled: boolean;
  practice?: boolean;
  heading?: string;
  stopRequestRef: { current: (() => void) | null };
  onClip: (blob: Blob, meta: TakeMeta) => void;
  onActive: (mode: MicMode) => void;
  onDiscard?: () => void;
}) {
  const supported = useMemo(() => supportedType(), []);
  const [mode, setMode] = useState<Mode>("idle");
  const [notice, setNotice] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState(() => readStored());
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const [checkOpen, setCheckOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [levelChecked, setLevelChecked] = useState(false);
  const [checkMetered, setCheckMetered] = useState(false);
  const [speechHeard, setSpeechHeard] = useState(false);
  const [ready, setReady] = useState(() => Boolean(readStored()));
  const [level, setLevel] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pauseSupported, setPauseSupported] = useState(false);
  const [warning, setWarning] = useState("");
  const [wakeHelp, setWakeHelp] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [take, setTake] = useState<{ blob: Blob; url: string; meta: TakeMeta } | null>(null);
  const [clipUrl, setClipUrl] = useState("");

  const micRef = useRef<HTMLButtonElement | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const activeStream = useRef<MediaStream | null>(null);
  const parts = useRef<Blob[]>([]);
  const finalized = useRef(false);
  const discarded = useRef(false);
  const interrupted = useRef(false);
  const finalIncomplete = useRef(false);
  const mounted = useRef(true);
  const locked = useRef(false);
  const modeRef = useRef<Mode>("idle");
  const deviceRef = useRef(device);
  const started = useRef(0);
  const pausedTotal = useRef(0);
  const pausedAt = useRef(0);
  const mutedAt = useRef(0);
  const warned = useRef(new Set<number>());
  const confirmPaused = useRef(false);
  const takeRef = useRef<{ url: string } | null>(null);
  const clipSeen = useRef(false);
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const levelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const meterCtx = useRef<AudioContext | null>(null);
  const meterRaf = useRef(0);
  const speechSeen = useRef(false);
  const meterRan = useRef(false);
  const wake = useRef<WakeLockSentinel | null>(null);
  const wakeWarned = useRef(false);
  const onClipRef = useRef(onClip);
  const onActiveRef = useRef(onActive);
  const onDiscardRef = useRef(onDiscard);
  useEffect(() => { onClipRef.current = onClip; }, [onClip]);
  useEffect(() => { onActiveRef.current = onActive; }, [onActive]);
  useEffect(() => { onDiscardRef.current = onDiscard; }, [onDiscard]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { deviceRef.current = device; }, [device]);

  const activeSeconds = () => {
    const now = Date.now();
    const pausedNow = pausedAt.current ? now - pausedAt.current : 0;
    return Math.max(0, (now - started.current - pausedTotal.current - pausedNow) / 1000);
  };
  const setMicMode = (next: Mode) => { modeRef.current = next; setMode(next); };

  function stopMeter() {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(meterRaf.current);
    void meterCtx.current?.close().catch(() => {});
    meterCtx.current = null;
    setLevel(0);
  }
  function startMeter(stream: MediaStream) {
    speechSeen.current = false;
    meterRan.current = false;
    let ctx: AudioContext | undefined;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      // Safari/iOS leaves contexts created outside a live gesture suspended;
      // a suspended analyser reports all zeros and must not be read as silence.
      void ctx.resume().catch(() => {});
      meterCtx.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let last = 0;
      const loop = (time: number) => {
        if (!meterCtx.current) return;
        meterRaf.current = requestAnimationFrame(loop);
        if (time - last < 100) return;
        last = time;
        if (ctx?.state !== "running") return;
        analyser.getFloatTimeDomainData(data);
        meterRan.current = true;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (rms > 0.02) speechSeen.current = true;
        setLevel(Math.min(1, rms * 6));
      };
      meterRaf.current = requestAnimationFrame(loop);
    } catch {
      void ctx?.close().catch(() => {});
      meterCtx.current = null;
    }
  }

  async function openStream(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(Error("unsupported"), { name: "NotFoundError" });
    const exact = deviceRef.current && deviceRef.current !== "default" ? deviceRef.current : "";
    const ask = async (wanted: boolean | { deviceId: { exact: string } }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          navigator.mediaDevices.getUserMedia({ audio: wanted }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError()), 30_000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    if (!exact) return ask(true);
    try { return await ask({ deviceId: { exact } }); }
    catch (error) {
      if (permissionDenied(error)) throw error;
      try {
        const stream = await ask(true);
        setDevice(""); writeStored("");
        setNotice("先前选择的麦克风当前不可用，已改用默认麦克风。");
        return stream;
      } catch { throw error; }
    }
  }

  async function requestWake() {
    const api = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> } }).wakeLock;
    if (!api) { setWakeHelp(true); return; }
    try {
      const sentinel = await api.request("screen");
      wake.current = sentinel;
      setWakeHelp(false);
      sentinel.addEventListener?.("release", () => { if (wake.current === sentinel) wake.current = null; });
    } catch { setWakeHelp(true); }
  }
  function releaseWake() {
    const sentinel = wake.current; wake.current = null;
    if (sentinel) void sentinel.release().catch(() => {});
  }

  async function runCheck() {
    if (checking) return;
    setChecking(true); setNotice(""); setLevelChecked(false); setCheckMetered(false); setSpeechHeard(false);
    let stream: MediaStream | undefined;
    try {
      stream = await openStream();
      if (!mounted.current || locked.current) { stream.getTracks().forEach(track => track.stop()); return; }
      setPermission("granted");
      let list: MediaDeviceInfo[] = [];
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        list = all.filter(entry => entry.kind === "audioinput");
      } catch { /* names may be hidden; keep default */ }
      setDevices(list);
      if (deviceRef.current && deviceRef.current !== "default" && !list.some(entry => entry.deviceId === deviceRef.current)) {
        setDevice(""); writeStored("");
        setNotice("先前选择的麦克风已不在此设备列表中，已改用默认麦克风。");
      }
      startMeter(stream);
      clearTimeout(levelTimer.current);
      levelTimer.current = setTimeout(() => {
        stopMeter();
        stream?.getTracks().forEach(track => track.stop());
        if (!mounted.current) return;
        setCheckMetered(meterRan.current);
        setSpeechHeard(meterRan.current && speechSeen.current);
        setLevelChecked(true); setChecking(false); setReady(true);
        writeStored(deviceRef.current || "default");
        setAnnouncement("麦克风检查完成，可以开始录音。");
      }, 3000);
    } catch (error) {
      stopMeter();
      stream?.getTracks().forEach(track => track.stop());
      if (!mounted.current) return;
      if (permissionDenied(error)) setPermission("denied");
      setNotice(micMessage(error));
      setChecking(false);
    }
  }

  function clearTake() {
    if (takeRef.current) { URL.revokeObjectURL(takeRef.current.url); takeRef.current = null; }
    setTake(null);
  }
  function startCountdown() {
    if (modeRef.current !== "idle" || disabled) return;
    if (!supported) {
      setNotice("此浏览器没有提供可用的录音格式，无法开始录音。请改用最新版 Chrome、Edge、Safari 或 Firefox。");
      return;
    }
    locked.current = false;
    setNotice(""); setWarning(""); setStopArmed(false); setConfirmCancel(false);
    setMicMode("waiting"); onActiveRef.current("waiting");
    setCountdown(3); setAnnouncement("3 秒后开始录音；按 Esc 可以取消。");
    let value = 3;
    const tick = () => {
      if (!mounted.current) return;
      value -= 1;
      if (value > 0) {
        setCountdown(value); setAnnouncement(`${value}`);
        countdownTimer.current = setTimeout(tick, 1000);
      } else { setCountdown(0); void begin(); }
    };
    clearTimeout(countdownTimer.current);
    countdownTimer.current = setTimeout(tick, 1000);
  }
  function cancelCountdown() {
    clearTimeout(countdownTimer.current); setCountdown(0);
    setMicMode("idle"); onActiveRef.current("idle");
    setAnnouncement("已取消录音倒计时。");
    setTimeout(() => micRef.current?.focus(), 0);
  }

  async function begin() {
    if (!mounted.current || locked.current) return;
    const preferred = supportedType();
    if (!preferred) {
      setNotice("此浏览器没有提供可用的录音格式。请更新浏览器，或改用页面外口头练习。");
      setMicMode("idle"); onActiveRef.current("idle"); return;
    }
    let stream: MediaStream | undefined;
    try { stream = await openStream(); }
    catch (error) {
      if (mounted.current) {
        setNotice(micMessage(error)); setMicMode("idle"); onActiveRef.current("idle");
      }
      return;
    }
    if (!mounted.current || locked.current) { stream.getTracks().forEach(track => track.stop()); return; }
    activeStream.current = stream;
    void requestWake();
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(stream, { mimeType: preferred, audioBitsPerSecond: 64000 }); }
    catch {
      activeStream.current = null; stream.getTracks().forEach(track => track.stop());
      setNotice("此浏览器无法用可用格式开始录音。请更新浏览器，或在页面外口头练习并记录要点。");
      setMicMode("idle"); onActiveRef.current("idle"); return;
    }
    recorder.current = rec;
    setPauseSupported(typeof (rec as MediaRecorder & { pause?: () => void }).pause === "function");
    parts.current = []; finalized.current = false; discarded.current = false; interrupted.current = false;
    finalIncomplete.current = false;
    started.current = Date.now(); pausedTotal.current = 0; pausedAt.current = 0; mutedAt.current = 0;
    warned.current = new Set(); confirmPaused.current = false;
    setDuration(0); setPaused(false); setWarning(""); setStopArmed(false);
    startMeter(stream);
    rec.ondataavailable = event => { if (event.data.size) parts.current.push(event.data); };
    rec.onstop = () => finish(false);
    rec.onerror = () => {
      interrupted.current = true;
      if (mounted.current) setNotice("录音中断。已收到的部分仍可试听。");
      stopNow(true);
    };
    const track = stream.getTracks()[0];
    track?.addEventListener?.("ended", () => {
      if (finalized.current) return;
      interrupted.current = true;
      if (mounted.current) setNotice("麦克风连接已断开，录音已停止。已收到的部分仍可试听。");
      stopNow(true);
    });
    track?.addEventListener?.("mute", () => { mutedAt.current = Date.now(); });
    track?.addEventListener?.("unmute", () => { mutedAt.current = 0; });
    try { rec.start(1000); }
    catch {
      activeStream.current = null; stream.getTracks().forEach(t => t.stop());
      stopMeter(); releaseWake();
      setNotice("无法开始录音，请检查麦克风后重试。");
      setMicMode("idle"); onActiveRef.current("idle"); return;
    }
    stopRequestRef.current = () => stopNow(false);
    clearInterval(ticker.current);
    ticker.current = setInterval(tickRecording, 200);
    setMicMode("recording"); onActiveRef.current("recording");
    setAnnouncement("录音开始。时间到时自动停止。");
  }

  function tickRecording() {
    if (modeRef.current !== "recording" && modeRef.current !== "paused") return;
    const seconds = activeSeconds();
    setDuration(Math.min(limit, Math.floor(seconds)));
    const left = limit - seconds;
    for (const at of WARN_AT) {
      if (left <= at && !warned.current.has(at)) {
        warned.current.add(at);
        setWarning(`还剩 ${at} 秒，时间到会自动停止。`);
        setAnnouncement(`还剩 ${at} 秒。`);
      }
    }
    if (mutedAt.current && Date.now() - mutedAt.current > 3000) {
      mutedAt.current = 0; interrupted.current = true;
      setNotice("麦克风长时间没有输入，已停止录音。请试听或重录。");
      stopNow(true); return;
    }
    if (seconds >= limit) stopNow(false);
  }

  function stopNow(incomplete: boolean) {
    const rec = recorder.current;
    if (!rec || finalized.current || modeRef.current === "stopping") return;
    if (incomplete) finalIncomplete.current = true;
    setMicMode("stopping"); onActiveRef.current("stopping");
    setWarning(""); setStopArmed(false); setConfirmCancel(false);
    clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => finish(true), 10_000);
    try {
      if (rec.state === "recording") rec.stop();
      else if (rec.state === "paused") { rec.resume(); rec.stop(); }
      else finish(incomplete || interrupted.current);
    } catch { finish(true); }
  }

  function finish(incomplete: boolean) {
    const rec = recorder.current;
    if (finalized.current) return;
    finalized.current = true;
    clearTimeout(stopTimer.current); clearInterval(ticker.current);
    stopRequestRef.current = null;
    stopMeter();
    activeStream.current?.getTracks().forEach(track => track.stop());
    activeStream.current = null;
    releaseWake();
    const durationMs = Math.round(activeSeconds() * 1000);
    const wasDiscarded = discarded.current;
    const wasInterrupted = interrupted.current;
    // A requested early stop (access lock, error path) is partial even when the
    // recorder itself ended cleanly.
    const partial = incomplete || finalIncomplete.current || wasInterrupted;
    const metered = meterRan.current;
    const silent = metered && !speechSeen.current;
    const chunks = parts.current.slice(); parts.current = [];
    if (!mounted.current) return;
    setPaused(false); setConfirmCancel(false); setStopArmed(false); setWarning(""); setDuration(0);
    if (wasDiscarded) {
      setNotice("已放弃这次录音。"); setAnnouncement("已放弃这次录音。");
      setMicMode("idle"); onActiveRef.current("idle");
      setTimeout(() => micRef.current?.focus(), 0);
      return;
    }
    if (chunks.length) {
      const blob = new Blob(chunks, { type: rec?.mimeType || supportedType() || "audio/webm" });
      const url = URL.createObjectURL(blob);
      clearTake();
      takeRef.current = { url };
      // A new take has not been adopted by the parent yet. Without this reset
      // the previous clip's `clipSeen` flag clears the fresh summary on the
      // next effect pass, hiding the duration and the honest device verdict.
      clipSeen.current = false;
      const entry = { blob, url, meta: { durationMs, silent, metered, incomplete: partial, interrupted: wasInterrupted } };
      setTake(entry);
      onClipRef.current(blob, entry.meta);
      setAnnouncement("录音已停止，请试听后保存或重录。");
      if (partial) setNotice("录音可能不完整：已保留收到的部分。请试听确认后再保存。");
      else if (silent) setNotice("电平表显示本次录音接近静音（设备估算，非校准指标）。建议重录后再保存。");
      else setNotice("");
    } else {
      setNotice("没有录到声音，请重试或改为口头自报。");
    }
    setMicMode("idle"); onActiveRef.current("idle");
    setTimeout(() => micRef.current?.focus(), 0);
  }

  function discardTake(restart = false) {
    setConfirmCancel(false); confirmPaused.current = false;
    clearTimeout(countdownTimer.current); setCountdown(0);
    const current = modeRef.current;
    if (current === "recording" || current === "paused" || current === "stopping" || current === "waiting") {
      discarded.current = true;
      clearTake();
      if (current === "waiting") { setMicMode("idle"); onActiveRef.current("idle"); }
      else stopNow(true);
      setAnnouncement("已放弃本次录音。");
      if (restart) setTimeout(startCountdown, 80);
      return;
    }
    clearTake();
    onDiscardRef.current?.();
    setNotice("已移除这段录音。"); setAnnouncement("已放弃本次录音。");
    if (restart) setTimeout(startCountdown, 80);
    else setTimeout(() => micRef.current?.focus(), 0);
  }

  function togglePause() {
    const rec = recorder.current;
    if (!rec || !pauseSupported || finalized.current) return;
    if (paused) {
      pausedTotal.current += Date.now() - pausedAt.current;
      pausedAt.current = 0;
      try { rec.resume(); } catch { return; }
      setPaused(false); setMicMode("recording"); setAnnouncement("继续录音。");
    } else {
      pausedAt.current = Date.now();
      try { rec.pause(); } catch { pausedAt.current = 0; return; }
      setPaused(true); setMicMode("paused"); setAnnouncement("录音已暂停，暂停时间不计入时长。");
    }
  }

  function openCancel() {
    if (modeRef.current === "waiting") { cancelCountdown(); return; }
    if (modeRef.current !== "recording" && modeRef.current !== "paused") return;
    setConfirmCancel(true); confirmPaused.current = false;
    if (!paused && pauseSupported && recorder.current) {
      try {
        pausedAt.current = Date.now();
        recorder.current.pause();
        setPaused(true); setMicMode("paused"); confirmPaused.current = true;
      } catch { pausedAt.current = 0; }
    }
    setAnnouncement("已打开放弃录音确认。请选择继续或放弃。");
  }
  function closeCancel() {
    setConfirmCancel(false);
    if (confirmPaused.current) {
      confirmPaused.current = false;
      const rec = recorder.current;
      if (rec && rec.state === "paused") {
        pausedTotal.current += Date.now() - pausedAt.current; pausedAt.current = 0;
        try { rec.resume(); } catch { /* ignore */ }
        setPaused(false); setMicMode("recording");
      }
    }
  }

  function armStop() {
    if (stopArmed) { setStopArmed(false); stopNow(false); return; }
    setStopArmed(true); setAnnouncement("再按一次空格或回车，确认停止录音。");
    clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => { if (mounted.current) setStopArmed(false); }, 4000);
  }
  function press() {
    if (disabled && mode !== "recording" && mode !== "paused") return;
    if (countdown > 0) { cancelCountdown(); return; }
    if (mode === "recording" || mode === "paused") { stopNow(false); return; }
    if (mode !== "idle") return;
    if (!supported) {
      setNotice("此浏览器没有提供可用的录音格式。请改用最新版 Chrome、Edge、Safari 或 Firefox。");
      return;
    }
    if (!ready) { setCheckOpen(true); void runCheck(); return; }
    startCountdown();
  }
  function micKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter" && event.key !== "Spacebar") return;
    event.preventDefault();
    if (mode === "recording" || mode === "paused") armStop();
    else if (mode === "idle") press();
    else if (countdown > 0) cancelCountdown();
  }

  const stopNowRef = useRef(stopNow);
  stopNowRef.current = stopNow;
  useEffect(() => {
    const stop = () => {
      locked.current = true;
      clearTimeout(countdownTimer.current); setCountdown(0);
      const current = modeRef.current;
      if (current === "recording" || current === "paused") stopNowRef.current(true);
      else if (current === "waiting") { setMicMode("idle"); onActiveRef.current("idle"); }
    };
    window.addEventListener("bandroom:access-locked", stop);
    return () => window.removeEventListener("bandroom:access-locked", stop);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmCancel) closeCancel();
      else if (checkOpen) setCheckOpen(false);
      else if (mode === "waiting") cancelCountdown();
      else if (mode === "recording" || mode === "paused") openCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(countdownTimer.current); clearTimeout(stopTimer.current);
      clearTimeout(disarmTimer.current); clearTimeout(levelTimer.current);
      clearInterval(ticker.current);
      stopRequestRef.current = null;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(meterRaf.current);
      void meterCtx.current?.close().catch(() => {});
      meterCtx.current = null;
      if (recorder.current && recorder.current.state !== "inactive") {
        try { recorder.current.stop(); } catch { /* already stopped */ }
      }
      activeStream.current?.getTracks().forEach(track => track.stop());
      releaseWake();
      if (takeRef.current) URL.revokeObjectURL(takeRef.current.url);
      takeRef.current = null;
    };
  }, [stopRequestRef]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && modeRef.current === "recording" && !wake.current) void requestWake();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  useEffect(() => {
    if (clip) clipSeen.current = true;
    else if (take && clipSeen.current && modeRef.current === "idle") { clearTake(); clipSeen.current = false; }
  }, [clip, take]);

  useEffect(() => {
    if (!clip || take) { setClipUrl(""); return; }
    const url = URL.createObjectURL(clip);
    setClipUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [clip, take]);

  const canStop = mode === "recording" || mode === "paused";
  const title = mode === "stopping" ? "正在整理录音"
    : mode === "recording" ? "正在录音"
      : mode === "paused" ? "录音已暂停"
        : mode === "waiting" && countdown > 0 ? `${countdown} 秒后开始`
          : mode === "waiting" ? "正在请求麦克风"
            : take ? "已录好，可试听"
              : clip ? "重新录制本次草稿" : (heading ?? "录下你的回答");
  const subtitle = mode === "recording" ? `${clock(duration)} / ${clock(limit)} · 点击停止`
    : mode === "paused" ? `暂停中 · 已计 ${clock(duration)}`
      : checkOpen ? "先确认麦克风，再开始计时"
        : `最多 ${clock(limit)} · 手动开始`;
  const micDisabled = !supported || mode === "stopping"
    || (mode === "waiting" && countdown === 0)
    || (disabled && mode === "idle");
  const downloadName = take?.blob.type.includes("mp4") ? "speaking.m4a"
    : take?.blob.type.includes("ogg") ? "speaking.ogg"
      : take?.blob.type.includes("wav") ? "speaking.wav" : "speaking.webm";

  return <div className="sp-recorder">
    {!supported && <div className="sp-mic-blocked" role="alert">
      <strong>这个浏览器不能录音</strong>
      <p className="sp-note">浏览器没有提供可用的录音格式。请改用最新版 Chrome、Edge、Safari 或 Firefox；也可以在页面外开口练习并记录要点。</p>
    </div>}
    <div className="sp-rec-main">
      <button ref={micRef} type="button" className={`sp-mic ${canStop ? "sp-recording" : ""}`}
        disabled={micDisabled}
        aria-label={canStop ? "停止录音" : "开始录音"}
        aria-pressed={canStop}
        aria-describedby="sp-rec-status"
        onClick={press} onKeyDown={micKey}>
        {canStop ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
          : <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="8.5" y="2.5" width="7" height="13" rx="3.5"/><path d="M5.5 11v1.5a6.5 6.5 0 0 0 13 0V11M12 19v3m-3 0h6"/></svg>}
      </button>
      <div id="sp-rec-status"><strong>{title}</strong><small>{subtitle}</small></div>
      {(canStop || checking) ? <LevelBar level={level}/> : <Wave/>}
    </div>
    <span className="sp-sr" aria-live="polite">{announcement}</span>
    {countdown > 0 && <div className="sp-countdown" role="status" aria-live="assertive">
      <b>{countdown}</b><span>即将开始录音</span>
      <button type="button" className="sp-link" onClick={cancelCountdown}>取消（Esc）</button>
    </div>}
    {mode === "recording" && warning && <p className="sp-timer-warn" role="status" aria-live="polite">{warning}</p>}
    {stopArmed && <p className="sp-note" role="status">再按一次空格或回车确认停止；点击停止按钮可直接结束。</p>}
    {wakeHelp && mode === "recording" && <p className="sp-note">请保持屏幕常亮，避免息屏中断录音。</p>}
    {practice && !pauseSupported && canStop && <p className="sp-note">此浏览器不支持录音暂停；可以停止后重录。</p>}
    {practice && pauseSupported && canStop && <div className="sp-rec-actions">
      <button type="button" className="secondary" disabled={disabled && !canStop} onClick={togglePause}>{paused ? "继续录音" : "暂停录音"}</button>
      {paused && <span className="sp-note">暂停时间不计入录音时长。</span>}
    </div>}
    {confirmCancel && <div className="sp-confirm" role="alertdialog" aria-label="确认放弃录音">
      <p>放弃本次录音？已录内容不会保存。</p>
      <div className="sp-rec-actions">
        <button type="button" className="secondary" onClick={() => discardTake(false)}>放弃本次录音</button>
        <button type="button" className="primary" onClick={closeCancel}>继续录音</button>
      </div>
    </div>}
    {checkOpen && <div className="sp-mic-check" role="group" aria-label="麦克风检查">
      <strong>先检查麦克风</strong>
      <p className="sp-note">检查只读取设备名称和 3 秒电平，不会保存这段检查音频。</p>
      {permission !== "granted"
        ? <p className="sp-note">默认麦克风（授权后可以切换设备）</p>
        : <label className="sp-label">录音设备
            <select value={device} disabled={checking} onChange={event => {
              const value = event.currentTarget.value;
              setDevice(value); writeStored(value); setLevelChecked(false); setSpeechHeard(false);
            }}>
              <option value="">默认麦克风</option>
              {devices.map((entry, index) => <option key={entry.deviceId || index} value={entry.deviceId}>{entry.label || `麦克风 ${index + 1}`}</option>)}
            </select>
          </label>}
      {checking && <p className="sp-note" role="status">正在检查电平… <LevelBar level={level}/></p>}
      {!checking && levelChecked && <p className="sp-note" role="status">{!checkMetered
        ? "浏览器未提供电平检测；可以直接试录一小段，再试听确认声音。"
        : speechHeard
          ? "检测到语音。"
          : "这 3 秒大部分是静音；请确认设备或系统权限后再开始。"}</p>}
      <div className="sp-rec-actions">
        {permission !== "granted" && <button type="button" className="primary" disabled={checking || disabled} onClick={() => void runCheck()}>
          {checking ? "正在请求麦克风…" : "允许麦克风并检查"}
        </button>}
        {permission === "granted" && <button type="button" className="primary" disabled={checking || disabled || !levelChecked}
          onClick={() => { setCheckOpen(false); startCountdown(); }}>使用此麦克风开始录音</button>}
        {permission === "granted" && <button type="button" className="secondary" disabled={checking || disabled} onClick={() => void runCheck()}>重新检查</button>}
        <button type="button" className="sp-link" onClick={() => setCheckOpen(false)}>取消</button>
      </div>
    </div>}
    {take && mode === "idle" && <div className="sp-take" role="status">
      <div className="sp-top"><strong>本次录音 {clock(Math.round(take.meta.durationMs / 1000))}</strong><span className="sp-status sp-status-suggestive">设备估算</span></div>
      <p className="sp-note">{!take.meta.metered
        ? "浏览器未提供电平检测；请试听确认这段录音。"
        : take.meta.silent
          ? "大部分静音：设备电平估算，非校准指标。建议重录。"
          : "检测到语音：设备电平估算，非校准指标。"}</p>
      {take.meta.incomplete && <p className="sp-message" role="status">录音可能不完整（麦克风中断或停止超时）。请试听；短于 3 秒的部分可能无法提交。</p>}
      <div className="sp-play"><audio controls src={take.url} aria-label="试听本次录音"/></div>
      <div className="sp-rec-actions">
        <a href={take.url} download={downloadName}>下载本次录音</a>
        <button type="button" className="secondary" disabled={disabled} onClick={() => discardTake(true)}>重新录制</button>
      </div>
    </div>}
    {!take && clipUrl && <div className="sp-play">
      <audio controls src={clipUrl} aria-label="试听本次录音"/>
      <a href={clipUrl} download={clip?.type.includes("mp4") ? "speaking.m4a" : clip?.type.includes("ogg") ? "speaking.ogg" : clip?.type.includes("wav") ? "speaking.wav" : "speaking.webm"}>下载本次录音</a>
    </div>}
    {notice && <p role="status" className="sp-message">{notice}</p>}
  </div>;
}


