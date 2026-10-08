// REPLAY OCR: image file → JSON lines of recognized text boxes (Apple Vision,
// on-device, zh-Hans + en). Coordinates are image pixels, origin top-left.
// Build: swiftc -O native/ocr.swift -o ~/.replay/bin/replay-ocr
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2, let img = NSImage(contentsOfFile: args[1]),
      let full = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: replay-ocr <image.png> [--crop x,y,w,h] [--fast]\n".data(using: .utf8)!)
  exit(2)
}
// Optional crop (image pixels). Output coordinates stay in full-image space.
var ox = 0.0, oy = 0.0
var cg = full
if let i = args.firstIndex(of: "--crop"), i + 1 < args.count {
  let v = args[i + 1].split(separator: ",").compactMap { Double($0) }
  if v.count == 4, let c = full.cropping(to: CGRect(x: v[0], y: v[1], width: v[2], height: v[3])) { cg = c; ox = v[0]; oy = v[1] }
}
let W = Double(cg.width), H = Double(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = args.contains("--fast") ? .fast : .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch {
  FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!)
  exit(1)
}
var out: [[String: Any]] = []
for obs in req.results ?? [] {
  guard let top = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  out.append([
    "text": top.string,
    "conf": Double(top.confidence),
    "x": (ox + b.minX * W).rounded(), "y": (oy + (1 - b.maxY) * H).rounded(),
    "w": (b.width * W).rounded(), "h": (b.height * H).rounded(),
  ])
}
let data = try! JSONSerialization.data(withJSONObject: ["width": Double(full.width), "height": Double(full.height), "boxes": out])
FileHandle.standardOutput.write(data)
