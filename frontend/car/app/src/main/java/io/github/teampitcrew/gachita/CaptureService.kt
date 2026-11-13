package io.github.teampitcrew.gachita

import ai.pleos.playground.stt.SpeechToText
import ai.pleos.playground.stt.constant.ErrorType
import ai.pleos.playground.stt.constant.Mode
import ai.pleos.playground.stt.listener.OnInitializeListener
import ai.pleos.playground.stt.listener.ResultListener
import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale
import kotlin.concurrent.thread

enum class Mic { OFF, STARTING, ON, BLOCKED, FAILED }

/** 수음 상태와 보관함. 서비스가 쓰고 화면이 읽는다. 같은 프로세스이고 메인 스레드에서만 바꾼다. */
object Live {
    var mic by mutableStateOf(Mic.OFF)
    var why by mutableStateOf("")
    var recent by mutableStateOf(emptyList<Utterance>())
    var count by mutableStateOf(0)
    var pending by mutableStateOf(0)
    /**
     * 원음(T63): 화면이 모두 동의한 것을 확인한 동의 세대. 수음 스레드는 이 세대로만 원음 파일을 연다(0이면 남기지 않음).
     * 동의 철회 뒤 화면이 알기 전에 읽힌 소리가 새 세대 파일로 넘어가지 않게.
     */
    @Volatile var rawGen = 0
    /** '원음 지우기'를 누른 여행. 화면이 파일을 지우고(쓰던 것까지), 수음 스레드는 다음 묶음에서 새 파일로 넘어간다. */
    @Volatile var rollRaw: String? = null

    /** 내비가 마지막으로 알려 준 위치. 기록 중에 화면이 10초마다 묻고, 서비스가 발화에 붙인다. */
    @Volatile var fix: Fix? = null
    /** 받아 적은 말 한 건이 보관함에 들어갈 때마다(메인 스레드). 부탁을 알아채는 화면(T9)이 건다. */
    var onHeard: ((Utterance) -> Unit)? = null
    var box: Outbox? = null
        private set

    /** 차 안 파일을 잠그는 키(Android Keystore로 감싼 데이터 키, T69). 보관함·할 일·저장한 여행·참가자 토큰이 같이 쓴다. 처음 부를 때 한 번 푼다. */
    @Volatile private var key: Seal? = null
    @Synchronized fun seal(ctx: Context): Seal = key ?: Seal.keystore(ctx.filesDir).also { key = it }

    /** 그 여행의 보관함. 앱을 다시 켜면 파일에서 이어 읽는다. */
    fun outbox(ctx: Context, trip: String): Outbox =
        box?.takeIf { it.trip == trip } ?: Outbox(ctx.filesDir, trip, seal(ctx)).also { box = it; show(it) }

    /** 여행의 차 안 파일을 지웠을 때(서버가 여행을 모름, 48시간). 그 여행의 보관함을 놓는다. */
    fun forget(trip: String) {
        if (box?.trip != trip) return
        box = null; recent = emptyList(); count = 0; pending = 0
    }

    fun show(o: Outbox) { recent = o.recent(2); count = o.size; pending = o.pending }

    fun set(m: Mic, reason: String = "") {
        if (m != mic || reason != why) Log.i(TAG, "수음 $m $reason") // 글자는 남기지 않는다
        mic = m; why = reason
    }
}

private const val TAG = "GachitaCapture"
private const val MIN_FREE = 500L * 1024 * 1024 // 남은 저장 공간이 이보다 적으면 가장 오래된 원음부터 지운다(T63)
private const val RESYNC_MS = 250L // 기기 시계가 원음 파일의 시각(표본 수로 셈)보다 녹음 버퍼 길이 + 이만큼 앞서면(표본을 잃음) 새 파일로(T63)
private const val CLOCK_BACK_MS = 5_000L // 기기 시계가 이만큼 뒤로 가면(시계를 맞춤) 새 파일로

/**
 * 마이크 포그라운드 서비스. AudioRecord(MIC, 16 kHz 2채널)를 쥐고 0.1초씩 읽어, 좌+우 모노로 Pleos STT(ON_DEVICE)에 sendAudio()로 넣는다.
 * STT가 마이크를 여는 request()는 부르지 않는다(우리 녹음과 같이 쓰면 무음만 받음, T10). 인식이 끝나도 그대로 계속 넣으면 다음 발화를 받는다(11/13).
 * 시작은 우리 화면이 앞일 때만(화면 뒤에서는 마이크 서비스를 시작할 수 없음, T10). 기록 동의를 확인하는 MainActivity가 켜고 끈다.
 * STT에 넣은 모노 소리는 장면을 고를 때까지 원음 파일로 암호화해 둔다(Raw.kt, T63). 동의 세대가 바뀌면 새 파일로 넘어간다.
 */
class CaptureService : Service() {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var stopping = false
    @Volatile private var held = false // Gleo에게 마이크를 넘긴 동안(T41). AudioRecord만 멈추고 서비스·STT는 둔다
    @Volatile private var rec: AudioRecord? = null
    @Volatile private var frames = 0L
    private var raw: RawWriter? = null // 읽기 스레드만 만진다
    private var rawOff = false // 저장 공간이 모자라 원음을 남기지 않는 중
    private var rawRetryAt = 0L // 원음 쓰기가 실패하거나 공간이 모자라면 이때까지 쉰다
    /**
     * 표본을 잃었다고 볼 어긋남(ms). 읽기 스레드가 밀려도 버퍼 길이 안이면 표본은 잃지 않는다(그 뒤 조각이 몰려옴).
     * 표본을 잃은 뒤 새 파일의 시작은 그 조각을 읽은 시각으로 잡으므로 실제보다 버퍼 길이만큼까지 늦을 수 있다(장면 구간의 앞뒤 여유로 덮음).
     */
    private var resyncMs = 1_000L
    private var worker: Thread? = null
    private var stt: SpeechToText? = null
    private var sttReady = false
    private val asm = Assembler()
    private val block = Blockage(System.currentTimeMillis())
    private lateinit var box: Outbox

    private val watch = object : Runnable {
        override fun run() {
            runCatching { rec?.activeRecordingConfiguration }.getOrNull()?.let { block.silenced = it.isClientSilenced }
            judge()
            main.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val trip = intent?.getStringExtra("trip")
        if (worker != null || trip == null) return START_NOT_STICKY
        try {
            startForeground(1, notice("기록 중"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (t: Throwable) { // 화면 뒤에서 시작하면 막힌다(T10)
            Log.w(TAG, "포그라운드 서비스를 시작하지 못함", t)
            Live.set(Mic.FAILED, "지금은 기록할 수 없어요 · 앱을 열어 주세요"); stopSelf(); return START_NOT_STICKY
        }
        current = this
        box = Live.outbox(this, trip)
        Live.rollRaw = null
        startStt()
        worker = thread(name = "capture") { record() }
        main.postDelayed(watch, 1000)
        return START_NOT_STICKY // 시스템이 다시 켜지 않는다. 동의 확인 없이 수음하지 않게
    }

    override fun onDestroy() {
        halt()
        main.removeCallbacks(watch)
        stt?.let { s -> runCatching { s.removeListener(listener); s.release() } }
        if (current === this) current = null
        super.onDestroy()
    }

    /** 마이크를 그 자리에서 놓는다. 읽기 스레드가 돌아오기를 기다리지 않는다. */
    private fun halt() {
        stopping = true
        rec?.let { runCatching { it.stop() } }
        if (Live.mic != Mic.FAILED) Live.set(Mic.OFF)
    }

    private fun startStt() {
        runCatching {
            stt = SpeechToText(this, Mode.ON_DEVICE).also { s ->
                s.initialize(object : OnInitializeListener {
                    override fun onSuccess() { main.post { if (!stopping) { s.addListener(listener); s.setLocale(Locale.KOREA); sttReady = true } } }
                    override fun onFailure(error: ErrorType) { main.post { Log.w(TAG, "STT 초기화 실패 ${error.name}"); Live.set(Live.mic, "받아쓰기를 시작하지 못했어요") } }
                })
            }
        }.onFailure { Log.w(TAG, "STT 만들기 실패", it); Live.set(Live.mic, "받아쓰기를 시작하지 못했어요") }
    }

    private val listener = object : ResultListener {
        override fun onUpdated(text: String, completed: Boolean) {
            val now = System.currentTimeMillis()
            main.post {
                if (stopping) return@post
                val audio = frames * 1000 / RATE
                if (!completed) asm.partial(now, audio)
                else asm.final(text, now, audio)?.let { d ->
                    val u = box.add(d, Live.fix)
                    Live.show(box)
                    Log.i(TAG, "발화 ${u.seq} ${u.text.length}자 ${u.endedAt - u.startedAt}ms") // 글자는 보관함에만
                    if (u.text.isNotEmpty()) Live.onHeard?.invoke(u) // 동의 철회 사이의 말은 글 없이 남는다
                }
            }
        }
        override fun onError(error: ErrorType) { Log.w(TAG, "STT 오류 ${error.name}") } // 계속 넣으면 다음 발화를 받는다
        override fun onUpdatedEpdData(on: Long, off: Long) {}
        override fun onStartedRecognition() {}
        override fun onEndedRecognition() {}
        override fun onReady() {}
        override fun onUpdatedRms(rms: Double) {}
    }

    private fun record() {
        val mask = AudioFormat.CHANNEL_IN_STEREO
        val enc = AudioFormat.ENCODING_PCM_16BIT
        val r = try {
            check(checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { "마이크 권한 없음" }
            AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setChannelMask(mask).setEncoding(enc).build())
                .setBufferSizeInBytes(maxOf(AudioRecord.getMinBufferSize(RATE, mask, enc) * 4, RATE * 2 * 2 / 2)).build()
                .also { check(it.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord 준비 안 됨" } }
        } catch (t: Throwable) {
            Log.w(TAG, "녹음을 열지 못함", t)
            main.post { Live.set(Mic.FAILED, "지금은 기록할 수 없어요"); stopSelf() }
            return
        }
        rec = r
        try {
            r.startRecording()
            resyncMs = r.bufferSizeInFrames * 1000L / RATE + RESYNC_MS
            val d = r.routedDevice
            Log.i(TAG, "녹음 시작 ${r.sampleRate} Hz ${r.channelCount}채널 ${d?.productName} 버퍼 ${r.bufferSizeInFrames * 1000 / RATE}ms")
            val buf = ShortArray(CHUNK_FRAMES * 2)
            var errors = 0
            while (!stopping) {
                if (held) { errors = 0; SystemClock.sleep(50); continue }
                val n = r.read(buf, 0, buf.size)
                if (n < 0) { if (++errors > 50) break; SystemClock.sleep(20); continue }
                if (n == 0) continue
                val c = downmix(buf, n)
                keep(c.mono, System.currentTimeMillis() - n / 2 * 1000L / RATE) // 이 조각 첫 표본의 기기 시각(읽기가 막 돌아옴)
                frames += n / 2
                val now = System.currentTimeMillis()
                main.post { chunk(c, now) }
            }
        } finally {
            runCatching { raw?.close() }; raw = null
            runCatching { r.stop() }
            r.release()
            rec = null
            Log.i(TAG, "녹음 끝 ${frames * 1000 / RATE}ms")
        }
    }

    /**
     * 0.1초 모노를 원음 파일에 암호화해 쓴다(읽기 스레드). 동의 세대가 바뀌면 그 세대의 새 파일을 연다(옛 세대 파일은 화면이 지움).
     * 1분마다와 파일을 열 때 남은 공간을 보고, 모자라면 다른 원음 파일을 오래된 것부터 지운다. 그래도 모자라면 원음만 남기지 않는다(받아쓰기는 계속).
     * 원음 쓰기가 실패해도 수음은 멈추지 않는다.
     */
    private fun keep(mono: ByteArray, at: Long) {
        if (stopping) return // 동의가 빠져 멈추는 중에 읽힌 조각은 남기지 않는다
        try {
            val w = raw
            val g = Live.rawGen
            // 새 파일로 넘어갈 때: 처음, 원음 지우기를 눌렀음, 모두 동의한 세대가 바뀜, 표본을 잃음(기기 시계가 표본 수보다 버퍼 길이 넘게 앞섬),
            // 기기 시계가 크게 뒤로 감. 읽기가 밀린 뒤 버퍼의 조각이 몰려올 때(기기 시계가 표본 수보다 뒤처짐)는 표본을 잃지 않았으니 넘어가지 않는다
            val drift = w?.let { at - (it.startedAt + it.frames * 1000 / RATE) } ?: 0
            val roll = w == null || Live.rollRaw == box.trip || w.trip != box.trip || w.generation != g || drift > resyncMs || drift < -CLOCK_BACK_MS
            if (roll) {
                if (Live.rollRaw == box.trip) Live.rollRaw = null
                w?.close(); raw = null
                if (g == 0 || at < rawRetryAt) return
                if (!room()) { rawRetryAt = at + 60_000; return }
                raw = RawWriter(filesDir, box.trip, g, at, Live.seal(this))
            } else if ((w.frames / CHUNK_FRAMES) % 600 == 0L && !room()) { // 1분마다 남은 공간
                w.close(); raw = null; rawRetryAt = at + 60_000; return
            }
            raw?.write(mono)
        } catch (t: Throwable) {
            Log.w(TAG, "원음을 쓰지 못함", t)
            runCatching { raw?.close() }; raw = null
            rawRetryAt = at + 60_000 // 1분 쉬었다 다시(0.1초마다 파일을 만들지 않게)
        }
    }

    /** 남은 공간이 모자라면 다른 원음 파일을 오래된 것부터 지운다. 그래도 모자라면 false(원음만 남기지 않음, 화면에 알림). */
    private fun room(): Boolean {
        var ok = true
        while (filesDir.usableSpace < MIN_FREE) {
            val old = filesDir.listFiles().orEmpty().filter { it.isFile && it.name.startsWith("audio-") && it != raw?.file }.minByOrNull { it.lastModified() }
            if (old == null || !old.delete()) { ok = false; break }
            Log.i(TAG, "저장 공간이 모자라 오래된 원음을 지움")
        }
        if (ok == rawOff) { rawOff = !ok; main.post { Live.set(Live.mic, if (ok) "" else "저장 공간이 모자라 원음을 남기지 않아요") } }
        return ok
    }

    /**
     * 조각 하나(메인 스레드). 막혔어도 STT에는 그대로 넣는다(막힌 조각은 0이라 무음일 뿐).
     * 넣지 않으면 STT가 말 끝의 무음을 받지 못해 발화를 닫지 못한다(11/13 E2E run2: 쉼이 디지털 0인 소리에서 쉼마다 막힘으로 판정됨).
     */
    private fun chunk(c: Chunk, now: Long) {
        if (stopping) return
        block.chunk(c.allZero, now)
        if (sttReady) runCatching { stt?.sendAudio(c.mono) }.onFailure { Log.w(TAG, "sendAudio 실패", it) }
        judge()
    }

    private fun judge() {
        if (stopping || held) return
        val why = block.reason(System.currentTimeMillis())
        if (why == null && frames == 0L) return // 첫 조각을 읽기 전에는 '기록 중'이라고 하지 않는다
        val m = if (why == null) Mic.ON else Mic.BLOCKED
        if (m != Live.mic) {
            Live.set(m, why ?: "")
            getSystemService(NotificationManager::class.java).notify(1, notice(if (m == Mic.ON) "기록 중" else "기록 멈춤 · 앱을 열어 주세요"))
        }
    }

    private fun notice(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("capture", "대화 기록", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "capture").setContentTitle("가치타").setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now).setOngoing(true).setContentIntent(open).build()
    }

    companion object {
        @Volatile private var current: CaptureService? = null
        val running: Boolean get() = Live.mic == Mic.STARTING || Live.mic == Mic.ON || Live.mic == Mic.BLOCKED

        /** 앞 화면에서만 부른다. */
        fun start(ctx: Context, trip: String) {
            Live.set(Mic.STARTING)
            runCatching { ctx.startForegroundService(Intent(ctx, CaptureService::class.java).putExtra("trip", trip)) }
                .onFailure { Log.w(TAG, "서비스를 시작하지 못함", it); Live.set(Mic.FAILED, "지금은 기록할 수 없어요 · 앱을 열어 주세요") }
        }

        /**
         * Gleo에게 마이크를 넘기거나(true) 돌려받는다(false). AudioRecord만 멈추고 다시 시작한다(서비스·STT·순번은 그대로, T41).
         * 넘긴 동안은 막힘을 판정하지 않고, 돌려받으면 막힘 시계를 새로 센다. 메인 스레드에서 부른다.
         */
        fun hold(on: Boolean) {
            val s = current ?: return
            if (on == s.held) return
            if (on) { s.held = true; s.rec?.let { runCatching { it.stop() } } }
            else { s.rec?.let { runCatching { it.startRecording() } }; s.block.chunk(false, System.currentTimeMillis()); s.held = false }
            Log.i(TAG, if (on) "녹음 잠시 멈춤" else "녹음 다시 시작")
            s.getSystemService(NotificationManager::class.java).notify(1, s.notice(if (on) "기록 잠시 멈춤 · Gleo 쓰는 중" else "기록 중"))
        }

        /** 동의가 꺼지면 바로 멈추고 마이크를 놓는다. 끝나지 않은 발화(중간 결과만 있는 것)는 남기지 않는다. */
        fun stop(ctx: Context) {
            current?.halt()
            Live.set(Mic.OFF)
            ctx.stopService(Intent(ctx, CaptureService::class.java))
        }
    }
}
