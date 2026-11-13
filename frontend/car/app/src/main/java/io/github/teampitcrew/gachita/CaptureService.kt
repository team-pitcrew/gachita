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
    @Volatile var gear: String? = null
    /** 받아 적은 말 한 건이 보관함에 들어갈 때마다(메인 스레드). 부탁을 알아채는 화면(T9)이 건다. */
    var onHeard: ((Utterance) -> Unit)? = null
    var box: Outbox? = null
        private set

    /** 그 여행의 보관함. 앱을 다시 켜면 파일에서 이어 읽는다. */
    fun outbox(ctx: Context, trip: String): Outbox =
        box?.takeIf { it.trip == trip } ?: Outbox(ctx.filesDir, trip).also { box = it; show(it) }

    fun show(o: Outbox) { recent = o.recent(2); count = o.size; pending = o.pending }

    fun set(m: Mic, reason: String = "") {
        if (m != mic || reason != why) Log.i(TAG, "수음 $m $reason") // 글자는 남기지 않는다
        mic = m; why = reason
    }
}

private const val TAG = "GachitaCapture"

/**
 * 마이크 포그라운드 서비스. AudioRecord(MIC, 16 kHz 2채널)를 쥐고 0.1초씩 읽어, 좌+우 모노로 Pleos STT(ON_DEVICE)에 sendAudio()로 넣는다.
 * STT가 마이크를 여는 request()는 부르지 않는다(우리 녹음과 같이 쓰면 무음만 받음, T10). 인식이 끝나도 그대로 계속 넣으면 다음 발화를 받는다(11/13).
 * 시작은 우리 화면이 앞일 때만(화면 뒤에서는 마이크 서비스를 시작할 수 없음, T10). 기록 동의를 확인하는 MainActivity가 켜고 끈다.
 */
class CaptureService : Service() {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var stopping = false
    @Volatile private var rec: AudioRecord? = null
    @Volatile private var frames = 0L
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
                    val u = box.add(d, Live.gear)
                    Live.show(box)
                    Log.i(TAG, "발화 ${u.seq} ${u.text.length}자 ${u.endedAt - u.startedAt}ms") // 글자는 보관함에만
                    Live.onHeard?.invoke(u)
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
            val d = r.routedDevice
            Log.i(TAG, "녹음 시작 ${r.sampleRate} Hz ${r.channelCount}채널 ${d?.productName}")
            val buf = ShortArray(CHUNK_FRAMES * 2)
            var errors = 0
            while (!stopping) {
                val n = r.read(buf, 0, buf.size)
                if (n < 0) { if (++errors > 50) break; SystemClock.sleep(20); continue }
                if (n == 0) continue
                val c = downmix(buf, n)
                frames += n / 2
                val now = System.currentTimeMillis()
                main.post { chunk(c, now) }
            }
        } finally {
            runCatching { r.stop() }
            r.release()
            rec = null
            Log.i(TAG, "녹음 끝 ${frames * 1000 / RATE}ms")
        }
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
        if (stopping) return
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
        return Notification.Builder(this, "capture").setContentTitle("같이타").setContentText(text)
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

        /** 동의가 꺼지면 바로 멈추고 마이크를 놓는다. 끝나지 않은 발화(중간 결과만 있는 것)는 남기지 않는다. */
        fun stop(ctx: Context) {
            current?.halt()
            Live.set(Mic.OFF)
            ctx.stopService(Intent(ctx, CaptureService::class.java))
        }
    }
}
