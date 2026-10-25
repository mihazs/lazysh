import AVFoundation
import Foundation
import Speech
import Tauri
import UIKit

struct SpeechRequest: Decodable { let requestId: String; let language: String?; let samples: [Float]? }
private enum SpeechFailure: Error {
  case invalid, unavailable, missingModel, timeout, cancelled, modelLimit, format, outputLimit
  var message: String {
    switch self {
    case .invalid: return "Invalid Apple speech input."
    case .unavailable: return "Apple SpeechAnalyzer requires supported iOS 26+ hardware."
    case .missingModel: return "Install the selected Apple language model before transcribing."
    case .timeout: return "Apple speech operation timed out."
    case .cancelled: return "Apple speech operation cancelled."
    case .modelLimit: return "Release an Apple language reservation before installing another (maximum three)."
    case .format: return "Apple SpeechAnalyzer could not prepare this audio format."
    case .outputLimit: return "Transcription exceeds the text limit."
    }
  }
}
private struct SpeechJob { let id: String; let invoke: Invoke; var task: Task<Void, Never>?; var timer: Task<Void, Never>? }

class AppleSpeechPlugin: Plugin {
  private let lock = NSLock()
  private var job: SpeechJob?
  private var cancelled: [String] = []
  private var backgroundObserver: NSObjectProtocol?
  private var foregroundObserver: NSObjectProtocol?
  private var foreground = true
  override init() {
    super.init()
    backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.background() }
    foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.resume() }
  }
  deinit {
    if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
    if let observer = foregroundObserver { NotificationCenter.default.removeObserver(observer) }
    job?.task?.cancel(); job?.timer?.cancel()
  }
  private func resume() { lock.lock(); foreground = true; lock.unlock() }
  private func background() {
    lock.lock(); foreground = false; let current = job; job = nil
    if let current = current { rememberCancellation(current.id); current.invoke.reject(SpeechFailure.cancelled.message) }
    lock.unlock(); current?.task?.cancel(); current?.timer?.cancel()
  }
  private func rememberCancellation(_ id: String) {
    if !cancelled.contains(id) { cancelled.append(id) }
    // shortcut: retain 128 recent cancellation IDs; use a native generation if concurrent queued voice actions are introduced.
    if cancelled.count > 128 { cancelled.removeFirst(cancelled.count - 128) }
  }
  private func request(_ invoke: Invoke, audio: Bool = false) throws -> SpeechRequest {
    let args = try invoke.parseArgs(SpeechRequest.self)
    guard args.requestId.utf8.count <= 64, UUID(uuidString: args.requestId) != nil else { throw SpeechFailure.invalid }
    if let language = args.language { guard !language.isEmpty && language.utf8.count <= 64 else { throw SpeechFailure.invalid } }
    if audio { guard let samples = args.samples, (1600...480000).contains(samples.count), samples.allSatisfy({ $0.isFinite && abs($0) <= 1 }) else { throw SpeechFailure.invalid } }
    return args
  }
  private func allowed(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return foreground && job?.id == id && !cancelled.contains(id) }
  private func finish(_ id: String, text: String?, error: Error?) {
    lock.lock(); defer { lock.unlock() }
    guard let current = job, current.id == id else { return }; job = nil; current.timer?.cancel()
    if !foreground || cancelled.contains(id) { current.invoke.reject(SpeechFailure.cancelled.message) }
    else if let failure = error as? SpeechFailure { current.invoke.reject(failure.message) }
    else if error != nil { current.invoke.reject("Apple speech operation failed. Whisper remains available.") }
    else if let text = text { current.invoke.resolve(["text": text]) }
    else { current.invoke.resolve() }
  }
  private func expire(_ id: String) {
    lock.lock()
    guard let current = job, current.id == id else { lock.unlock(); return }
    job = nil; rememberCancellation(id); current.invoke.reject(SpeechFailure.timeout.message)
    lock.unlock(); current.task?.cancel()
  }
  private func start(_ args: SpeechRequest, _ invoke: Invoke, timeout: UInt64, action: @escaping () async throws -> String?) {
    lock.lock()
    guard foreground && job == nil && !cancelled.contains(args.requestId) else { lock.unlock(); invoke.reject("Apple speech is busy, cancelled or in the background."); return }
    job = SpeechJob(id: args.requestId, invoke: invoke, task: nil, timer: nil); lock.unlock()
    let task = Task {
      do {
        try Task.checkCancellation(); guard self.allowed(args.requestId) else { throw SpeechFailure.cancelled }
        let text = try await action()
        self.finish(args.requestId, text: text, error: nil)
      } catch { self.finish(args.requestId, text: nil, error: error) }
    }
    let timer = Task {
      do { try await Task.sleep(nanoseconds: timeout * 1_000_000_000); self.expire(args.requestId) } catch {}
    }
    lock.lock(); if job?.id == args.requestId { job?.task = task; job?.timer = timer; lock.unlock() } else { lock.unlock(); task.cancel(); timer.cancel() }
  }
  @objc public func cancel(_ invoke: Invoke) throws {
    let args = try request(invoke)
    lock.lock(); rememberCancellation(args.requestId)
    let current = job?.id == args.requestId ? job : nil
    if current != nil { job = nil; current?.invoke.reject(SpeechFailure.cancelled.message) }
    invoke.resolve(); lock.unlock(); current?.task?.cancel(); current?.timer?.cancel()
  }
  @objc public func capability(_ invoke: Invoke) {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), SpeechTranscriber.isAvailable {
      Task {
        let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }.sorted()
        let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }.sorted()
        let reserved = await AssetInventory.reservedLocales.map { $0.identifier(.bcp47) }.sorted()
        invoke.resolve(["available": true, "reason": "Apple SpeechAnalyzer processes audio on this device.", "supportedLanguages": supported, "installedLanguages": installed, "reservedLanguages": reserved])
      }; return
    }
    #endif
    invoke.resolve(["available": false, "reason": SpeechFailure.unavailable.message, "supportedLanguages": [String](), "installedLanguages": [String](), "reservedLanguages": [String]()])
  }
  @objc public func installModel(_ invoke: Invoke) throws {
    let args = try request(invoke)
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), SpeechTranscriber.isAvailable {
      start(args, invoke, timeout: 300) { try await AnalyzerEngine.install(args.language ?? ""); return nil }; return
    }
    #endif
    invoke.reject(SpeechFailure.unavailable.message)
  }
  @objc public func releaseModel(_ invoke: Invoke) throws {
    let args = try request(invoke)
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), SpeechTranscriber.isAvailable {
      start(args, invoke, timeout: 30) { try await AnalyzerEngine.release(args.language ?? ""); return nil }; return
    }
    #endif
    invoke.reject(SpeechFailure.unavailable.message)
  }
  @objc public func transcribe(_ invoke: Invoke) throws {
    let args = try request(invoke, audio: true)
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), SpeechTranscriber.isAvailable {
      start(args, invoke, timeout: 120) { try await AnalyzerEngine.transcribe(args.samples ?? [], language: args.language ?? "") }; return
    }
    #endif
    invoke.reject(SpeechFailure.unavailable.message)
  }
}

#if compiler(>=6.2)
@available(iOS 26.0, *)
private enum AnalyzerEngine {
  static func locale(_ language: String) async throws -> Locale {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else { throw SpeechFailure.invalid }; return locale
  }
  static func install(_ language: String) async throws {
    try Task.checkCancellation(); let locale = try await locale(language)
    let reserved = await AssetInventory.reservedLocales
    if !reserved.contains(locale) && reserved.count >= 3 { throw SpeechFailure.modelLimit }
    let added = try await AssetInventory.reserve(locale: locale)
    do {
      try Task.checkCancellation(); let module = SpeechTranscriber(locale: locale, preset: .transcription)
      if let download = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
        try await withTaskCancellationHandler { try Task.checkCancellation(); try await download.downloadAndInstall() } onCancel: { download.progress.cancel() }
      }
      try Task.checkCancellation()
    } catch { if added { await AssetInventory.release(reservedLocale: locale) }; throw error }
  }
  static func release(_ language: String) async throws {
    try Task.checkCancellation(); let locale = try await locale(language); try Task.checkCancellation()
    await AssetInventory.release(reservedLocale: locale); try Task.checkCancellation()
  }
  static func audio(_ samples: [Float], format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    guard let sourceFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
          let source = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(samples.count)),
          let channel = source.floatChannelData?[0], format.sampleRate <= 48000, format.channelCount <= 2 else { throw SpeechFailure.format }
    source.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { pointer in if let base = pointer.baseAddress { channel.update(from: base, count: samples.count) } }
    if sourceFormat == format { return source }
    let count = ceil(Double(samples.count) * format.sampleRate / 16000) + 512
    guard count > 0 && count <= 1440512, let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)), let converter = AVAudioConverter(from: sourceFormat, to: format) else { throw SpeechFailure.format }
    converter.primeMethod = .none
    var supplied = false; var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, state in
      if supplied { state.pointee = .endOfStream; return nil }; supplied = true; state.pointee = .haveData; return source
    }
    guard status != .error && error == nil && output.frameLength > 0 else { throw SpeechFailure.format }; return output
  }
  static func collect(_ transcriber: SpeechTranscriber) async throws -> String {
    var text = ""
    for try await result in transcriber.results {
      try Task.checkCancellation(); if result.isFinal { text += String(result.text.characters) }
      if text.utf8.count > 65536 { throw SpeechFailure.outputLimit }
    }; return text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  static func transcribe(_ samples: [Float], language: String) async throws -> String {
    try Task.checkCancellation(); let locale = try await locale(language)
    let module = SpeechTranscriber(locale: locale, preset: .transcription)
    guard await AssetInventory.status(forModules: [module]) == .installed else { throw SpeechFailure.missingModel }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module], considering: nil) else { throw SpeechFailure.format }
    try Task.checkCancellation()
    let buffer = try audio(samples, format: format); let analyzer = SpeechAnalyzer(modules: [module])
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      async let transcript = collect(module)
      let sequence = AsyncStream<AnalyzerInput>(bufferingPolicy: .bufferingNewest(1)) { continuation in
        continuation.yield(AnalyzerInput(buffer: buffer, bufferStartTime: nil)); continuation.finish()
      }
      if let last = try await analyzer.analyzeSequence(sequence) { try await analyzer.finalizeAndFinish(through: last) }
      else { await analyzer.cancelAndFinishNow() }
      try Task.checkCancellation(); return try await transcript
    } onCancel: { Task { await analyzer.cancelAndFinishNow() } }
  }
}
#endif

@_cdecl("init_plugin_lazysh_apple_speech") public func initPlugin() -> Plugin { AppleSpeechPlugin() }
