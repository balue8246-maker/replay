// REPLAY Voice: narration while a human demonstrates. On-device speech
// recognition (Apple Speech framework), one JSON line per utterance:
//   {"start": <epoch ms>, "end": <epoch ms>, "text": "..."}
// Live mode listens to the microphone until SIGTERM/SIGINT or until the stop
// file appears; file mode transcribes an audio file (used by self-tests).
//
// It ships as a tiny app bundle (ReplayVoice.app) so macOS asks for microphone
// and speech-recognition permission in its own name with a normal popup.
//
//   replay-voice --out <file.jsonl> [--lang zh-CN] [--stop <file>]
//   replay-voice --file <audio> --out <file.jsonl> [--lang zh-CN] [--t0 <epoch ms>]
import AVFoundation
import Foundation
import Speech

let args = CommandLine.arguments
func opt(_ k: String) -> String? { if let i = args.firstIndex(of: k), i + 1 < args.count { return args[i + 1] }; return nil }
let outPath = opt("--out") ?? "/dev/stdout"
let lang = opt("--lang") ?? "zh-CN"
let stopPath = opt("--stop")
FileManager.default.createFile(atPath: outPath, contents: nil)
let out = FileHandle(forWritingAtPath: outPath) ?? FileHandle.standardOutput
out.seekToEndOfFile()
let nowMs = { Int64(Date().timeIntervalSince1970 * 1000) }

func emit(_ obj: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: obj), var s = String(data: d, encoding: .utf8) {
    s += "\n"; out.write(s.data(using: .utf8)!)
  }
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
  emit(["error": "no recognizer for \(lang)"]); exit(3)
}

// Speech permission: request it (system popup the first time). Some macOS
// builds never answer requestAuthorization for background helpers, so do not
// block on it for more than a few seconds; the recognition task itself asks too.
var authStatus = SFSpeechRecognizer.authorizationStatus()
emit(["authBefore": authStatus.rawValue])
if authStatus == .notDetermined {
  var answered = false
  SFSpeechRecognizer.requestAuthorization { s in authStatus = s; answered = true }
  let until = Date().addingTimeInterval(Double(opt("--auth-wait") ?? "") ?? 8)
  while !answered && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
}
if args.contains("--auth-only") { emit(["auth": authStatus.rawValue]); exit(authStatus == .authorized ? 0 : 4) }
if authStatus == .denied || authStatus == .restricted { emit(["error": "speech permission denied"]); exit(4) }

func segmentsToLines(_ r: SFSpeechRecognitionResult, base: Int64) {
  // Split a long transcription into utterances at pauses > 0.8 s.
  var cur = "", s0 = -1.0, last = 0.0
  for seg in r.bestTranscription.segments {
    if s0 >= 0 && seg.timestamp - last > 0.8 && !cur.isEmpty {
      emit(["start": base + Int64(s0 * 1000), "end": base + Int64(last * 1000), "text": cur]); cur = ""; s0 = -1
    }
    if s0 < 0 { s0 = seg.timestamp }
    cur += seg.substring; last = seg.timestamp + seg.duration
  }
  if !cur.isEmpty { emit(["start": base + Int64(max(s0, 0) * 1000), "end": base + Int64(last * 1000), "text": cur]) }
}

if let file = opt("--file") {
  let base = Int64(opt("--t0") ?? "") ?? nowMs()
  let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: file))
  if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
  req.shouldReportPartialResults = false
  let done = DispatchSemaphore(value: 0)
  emit(["onDevice": recognizer.supportsOnDeviceRecognition, "available": recognizer.isAvailable])
  recognizer.recognitionTask(with: req) { r, e in
    if let r = r, r.isFinal { segmentsToLines(r, base: base); done.signal() }
    else if let e = e { emit(["error": "\(e.localizedDescription) \((e as NSError).code)"]); done.signal() }
  }
  while done.wait(timeout: .now() + 0.05) == .timedOut { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  exit(0)
}

// Live microphone mode. Each utterance is its own request: a pause of 1.2 s
// without new words ends it, so lines stream out while the human works.
// Microphone permission first, explicitly: the system popup appears in this
// app's name. Wait for the answer (the stop file still works meanwhile).
let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
emit(["micBefore": micStatus.rawValue])
if micStatus == .denied || micStatus == .restricted {
  emit(["error": "microphone permission denied: System Settings › Privacy & Security › Microphone › REPLAY 旁白"]); exit(5)
}
if micStatus == .notDetermined {
  var answered = false, granted = false
  AVCaptureDevice.requestAccess(for: .audio) { g in granted = g; answered = true }
  emit(["waiting": "microphone"])
  let until = Date().addingTimeInterval(Double(opt("--mic-wait") ?? "") ?? 120)
  while !answered && Date() < until {
    if let p = stopPath, FileManager.default.fileExists(atPath: p) { exit(0) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  }
  if !answered { emit(["error": "microphone permission popup not answered"]); exit(5) }
  if !granted { emit(["error": "microphone permission denied"]); exit(5) }
}

let engine = AVAudioEngine()
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
var reqStart: Int64 = 0
var lastChange = Date()
var hasWords = false
var stopping = false

func startRequest() {
  let r = SFSpeechAudioBufferRecognitionRequest()
  r.shouldReportPartialResults = true
  if recognizer.supportsOnDeviceRecognition { r.requiresOnDeviceRecognition = true }
  if #available(macOS 13, *) { r.addsPunctuation = true }
  request = r; reqStart = nowMs(); hasWords = false; lastChange = Date()
  let base = reqStart
  task = recognizer.recognitionTask(with: r) { res, err in
    if let res = res {
      if !res.bestTranscription.formattedString.isEmpty { hasWords = true; lastChange = Date() }
      if res.isFinal {
        let t = res.bestTranscription.formattedString
        if !t.isEmpty {
          let segs = res.bestTranscription.segments
          let s = base + Int64((segs.first?.timestamp ?? 0) * 1000)
          let e = base + Int64(((segs.last?.timestamp ?? 0) + (segs.last?.duration ?? 0)) * 1000)
          emit(["start": s, "end": max(e, s), "text": t])
        }
        if !stopping { startRequest() }
      }
    } else if err != nil, !stopping {
      startRequest()
    }
  }
}

let input = engine.inputNode
let fmt = input.outputFormat(forBus: 0)
input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { buf, _ in request?.append(buf) }
engine.prepare()
do { try engine.start() } catch { emit(["error": "microphone: \(error.localizedDescription)"]); exit(5) }
emit(["ready": nowMs(), "lang": lang, "onDevice": recognizer.supportsOnDeviceRecognition])
startRequest()

func shutdown() {
  if stopping { return }
  stopping = true
  request?.endAudio()
  DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { engine.stop(); exit(0) }
}
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let srcT = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main); srcT.setEventHandler { shutdown() }; srcT.resume()
let srcI = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main); srcI.setEventHandler { shutdown() }; srcI.resume()

Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
  if let p = stopPath, FileManager.default.fileExists(atPath: p) { shutdown(); return }
  // End the utterance after a pause so it is finalized and written.
  if hasWords && Date().timeIntervalSince(lastChange) > 1.2 && !stopping { hasWords = false; request?.endAudio() }
  // Safety: requests are limited to about a minute.
  if !stopping && nowMs() - reqStart > 50_000 { request?.endAudio() }
}
RunLoop.main.run()
