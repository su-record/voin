// syscap: 맥에서 재생되는 모든 소리(시스템 오디오)를 잡아
// 16kHz 모노 float32 PCM으로 stdout에 계속 써 준다.
// Core Audio 프로세스 탭(macOS 14.2+)을 사용한다.
// 실행한 터미널 앱에 "시스템 오디오 녹음" 권한이 필요하다.
//
// 사용: syscap            # 소리는 그대로 들리면서 녹음
//       syscap --mute     # 테스트용: 스피커를 끈 채로 녹음

import AVFoundation
import CoreAudio
import Foundation

setvbuf(stdout, nil, _IONBF, 0)

func fail(_ message: String, _ status: OSStatus = noErr) -> Never {
    FileHandle.standardError.write("syscap: \(message) (OSStatus \(status))\n".data(using: .utf8)!)
    exit(1)
}

func readProperty<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T {
    var address = AudioObjectPropertyAddress(
        mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    if status != noErr { fail("속성 \(selector) 읽기 실패", status) }
    return value
}

// 1) 모든 프로세스의 출력 소리를 복사하는 탭 생성 (자기 자신은 제외할 필요 없음: 재생을 안 하므로)
let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDescription.uuid = UUID()
tapDescription.isPrivate = true
tapDescription.muteBehavior = CommandLine.arguments.contains("--mute") ? .muted : .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
var status = AudioHardwareCreateProcessTap(tapDescription, &tapID)
if status != noErr { fail("오디오 탭 생성 실패", status) }

// 2) 탭은 직접 읽을 수 없어 "집합 장치(aggregate device)"에 붙여서 읽는다
let outputDevice = readProperty(
    AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioDeviceID(0))
var uidAddress = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var uidRef: Unmanaged<CFString>?
var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
status = AudioObjectGetPropertyData(outputDevice, &uidAddress, 0, nil, &uidSize, &uidRef)
guard status == noErr, let uidRef else { fail("출력 장치 UID 읽기 실패", status) }
let outputUID = uidRef.takeRetainedValue() as String

let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey: "voin System Capture",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDescription.uuid.uuidString]
    ],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
if status != noErr { fail("집합 장치 생성 실패", status) }

func cleanup() {
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
}

// 3) 탭 형식(보통 48kHz 스테레오) → 16kHz 모노 변환기
var tapFormatDescription = readProperty(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
guard let tapFormat = AVAudioFormat(streamDescription: &tapFormatDescription),
    let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
    let converter = AVAudioConverter(from: tapFormat, to: outputFormat)
else { cleanup(); fail("오디오 형식 변환기 생성 실패") }

let queue = DispatchQueue(label: "syscap.io")
var procID: AudioDeviceIOProcID?
status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, inputData, _, _, _ in
    guard
        let input = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: inputData, deallocator: nil),
        input.frameLength > 0
    else { return }
    let capacity = AVAudioFrameCount(Double(input.frameLength) * 16000 / tapFormat.sampleRate) + 16
    guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
    var consumed = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, inputStatus in
        if consumed {
            inputStatus.pointee = .noDataNow
            return nil
        }
        consumed = true
        inputStatus.pointee = .haveData
        return input
    }
    if let error { FileHandle.standardError.write("syscap: 변환 오류 \(error)\n".data(using: .utf8)!) }
    if output.frameLength > 0, let samples = output.floatChannelData?[0] {
        let written = fwrite(samples, MemoryLayout<Float>.size, Int(output.frameLength), stdout)
        // 읽는 쪽(Node 서버)이 종료되면 같이 종료
        if written < Int(output.frameLength) { cleanup(); exit(0) }
    }
}
if status != noErr { cleanup(); fail("오디오 콜백 등록 실패", status) }

status = AudioDeviceStart(aggregateID, procID)
if status != noErr { cleanup(); fail("녹음 시작 실패", status) }
FileHandle.standardError.write(
    "syscap: 시작 (\(Int(tapFormat.sampleRate))Hz \(tapFormat.channelCount)ch → 16000Hz 1ch)\n".data(using: .utf8)!)

// 종료 신호를 받으면 탭과 집합 장치를 정리하고 끝낸다 (안 하면 시스템에 남는다)
signal(SIGPIPE, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        AudioDeviceStop(aggregateID, procID)
        cleanup()
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}
dispatchMain()
