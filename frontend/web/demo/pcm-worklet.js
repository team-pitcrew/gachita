// 실제 입력만 수집합니다. 출력 버퍼는 무음으로 두어 마이크를 스피커로 되돌리지 않습니다.
class GachitaPCM extends AudioWorkletProcessor {
  constructor() { super(); }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    const samples = new Float32Array(channels[0].length);
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0; for (const channel of channels) value += channel[i] / channels.length;
      samples[i] = value;
    }
    // 각 렌더 블록을 전달해 일시정지·종료 때 100ms짜리 내부 꼬리가 유실되지 않게 합니다.
    this.port.postMessage(samples, [samples.buffer]);
    return true;
  }
}
registerProcessor('gachita-pcm', GachitaPCM);
