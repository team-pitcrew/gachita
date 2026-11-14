"""E2E용 가상 마이크 배경음(-77 dBFS). 호스트 마이크나 사람 목소리를 쓰지 않습니다.

ANDROID_SERIAL, GACHITA_GRPC_PORT로 독립 에뮬레이터를 지정합니다.
-grpc-use-token -audio none으로 켠 기기에서만 실행합니다.
실행: python3 frontend/car/noise_fixture.py [초, 기본 300]
우리 AudioRecord가 활성일 때만 100ms씩 공급하고, 닫히면 즉시 중단합니다.
말소리 주입 시험과 동시에 실행하지 않습니다. 결과를 STT 검증으로 세지 않습니다.
"""
import sys, time
import numpy as np
from capture_e2e import Injector, NOISE_DBFS, R
from gleo_e2e import ours_recording

inj = Injector()
deadline = time.monotonic() + float(sys.argv[1] if len(sys.argv) > 1 else 300)
rng = np.random.default_rng(83)
rms = 32767 * 10 ** (NOISE_DBFS / 20)
fmt = inj.pb.AudioFormat(samplingRate=R, channels=inj.pb.AudioFormat.Stereo,
                         format=inj.pb.AudioFormat.AUD_FMT_S16, mode=inj.pb.AudioFormat.MODE_REAL_TIME)
while time.monotonic() < deadline:
    if not ours_recording():
        time.sleep(0.2)
        continue
    def packets():
        while time.monotonic() < deadline and ours_recording():
            pcm = rng.normal(0, rms, (R // 10, 2)).round().astype('<i2').tobytes()
            yield inj.pb.AudioPacket(format=fmt, timestamp=time.time_ns() // 1000, audio=pcm)
            time.sleep(0.1)
    try:
        inj.stub.injectAudio(packets(), metadata=inj.md, timeout=max(1, deadline-time.monotonic()))
    except inj.grpc.RpcError as exc:
        if exc.code() not in (inj.grpc.StatusCode.CANCELLED, inj.grpc.StatusCode.DEADLINE_EXCEEDED):
            raise
print('합성 배경음 공급 종료')
