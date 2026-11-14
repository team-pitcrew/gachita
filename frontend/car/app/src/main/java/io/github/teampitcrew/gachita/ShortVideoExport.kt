package io.github.teampitcrew.gachita

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.opengl.GLUtils
import android.os.Environment
import android.os.Looper
import android.provider.MediaStore
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.Surface
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CancellationException
import kotlin.math.ceil
import kotlin.math.sin

internal const val EXPORT_WIDTH = 1080
internal const val EXPORT_HEIGHT = 1920
internal const val EXPORT_FPS = 30
private const val EXPORT_SAMPLE_RATE = 16_000
private const val EXPORT_MAX_SECONDS = 45
private const val CODEC_WAIT_US = 10_000L

/** One export owns one control. The caller cancels it on consent, trip, driving or lifecycle changes. */
class ShortExportControl {
    @Volatile var isCancelled: Boolean = false
        private set

    @Synchronized fun cancel() { isCancelled = true }

    internal fun check() {
        if (isCancelled || Thread.currentThread().isInterrupted) throw CancellationException("영상 저장을 취소했어요")
    }

    // Publication and cancellation have one boundary. A cancellation before publication cannot expose the item.
    @Synchronized internal fun <T> publish(block: () -> T): T { check(); return block() }

    /** Network verification runs outside the monitor so cancellation stays immediate. */
    internal fun <T> publishAfter(beforePublish: () -> Unit, block: () -> T): T {
        check()
        beforePublish()
        return publish(block)
    }
}

data class SavedShortVideo(val uri: Uri, val displayName: String, val durationMs: Long)

/**
 * Saves an actual AVC/AAC MP4 only after an explicit user save action, on a background worker.
 * clips must be authorized local PCM16/mono/16 kHz WAVs in short.scenes order. Inputs remain caller-owned.
 * Uses the first 45 seconds, preserving recorded speech. No synthesized replacement voice or network calls.
 * Progress runs on this worker; dispatch it to the main thread before changing UI state.
 * The caller must recheck its scope when receiving the result and delete result.uri if that scope was revoked.
 */
fun exportShortVideo(
    context: Context,
    short: Short,
    clips: List<File>,
    people: List<Person>,
    control: ShortExportControl,
    beforePublish: () -> Unit,
    onProgress: (Float) -> Unit = {},
    targetFile: File? = null,
    maxSeconds: Int = EXPORT_MAX_SECONDS,
): SavedShortVideo {
    check(Looper.myLooper() != Looper.getMainLooper()) { "영상 저장은 백그라운드에서 실행해야 해요" }
    require(short.scenes.isNotEmpty() && clips.size == short.scenes.size) { "장면과 원음 클립이 맞지 않아요" }
    control.check()
    val app = context.applicationContext
    val videoFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, EXPORT_WIDTH, EXPORT_HEIGHT).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, 8_000_000)
        setInteger(MediaFormat.KEY_FRAME_RATE, EXPORT_FPS)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    val audioFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, EXPORT_SAMPLE_RATE, 1).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, 64_000)
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 4096)
    }
    val codecs = MediaCodecList(MediaCodecList.REGULAR_CODECS)
    val videoEncoder = codecs.findEncoderForFormat(videoFormat)
        ?: throw IllegalStateException("이 차량은 1080×1920 영상 저장을 지원하지 않아요")
    val audioEncoder = codecs.findEncoderForFormat(audioFormat)
        ?: throw IllegalStateException("이 차량은 원음의 AAC 저장을 지원하지 않아요")
    onProgress(0f)
    require(maxSeconds in 1..60)
    val timeline = exportTimeline(short, clips, control, maxSeconds)
    val durationUs = timeline.sumOf { it.durationUs }
    val temporary = mutableListOf<File>()
    fun temp(suffix: String) = File.createTempFile("short-export-", suffix, app.cacheDir).also { temporary += it }
    var pending: Uri? = null
    try {
        val video = temp("-video.mp4")
        val audio = temp("-audio.m4a")
        val result = temp(".mp4")
        ExportScenePainter(app, short, people).use { painter ->
            encodeVideo(video, videoEncoder, videoFormat, timeline, painter, control) { onProgress(0.05f + it * 0.73f) }
        }
        encodeAudio(audio, audioEncoder, audioFormat, timeline, control) { onProgress(0.78f + it * 0.12f) }
        combineTracks(video, audio, result, durationUs, control) { onProgress(0.90f + it * 0.07f) }
        control.check()
        check(result.length() > 0) { "완성된 영상이 비어 있어요" }
        validateRenderedShort(result, durationUs)
        if (targetFile != null) {
            require(result.length() <= SHARED_SHORT_MAX_BYTES) { "영상은 64MB까지 보관할 수 있어요" }
            control.publishAfter(beforePublish) { result.copyTo(targetFile, overwrite = true) }
            return SavedShortVideo(Uri.fromFile(targetFile), targetFile.name, durationUs / 1000)
        }
        val name = "가치타_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.ROOT).format(Date())}_${UUID.randomUUID().toString().take(8)}.mp4"
        val resolver = app.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/Gachita")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
            ?: throw IllegalStateException("영상을 저장할 공간을 열지 못했어요")
        pending = uri
        resolver.openOutputStream(uri, "w")?.use { output ->
            result.inputStream().use { input ->
                val buffer = ByteArray(128 * 1024)
                var copied = 0L
                while (true) {
                    control.check()
                    val n = input.read(buffer)
                    if (n < 0) break
                    output.write(buffer, 0, n); copied += n
                    onProgress(0.97f + 0.025f * copied / result.length())
                }
            }
        } ?: throw IllegalStateException("영상 파일을 쓰지 못했어요")
        return control.publishAfter(beforePublish) {
            check(resolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null) == 1) {
                "영상 저장을 마치지 못했어요"
            }
            onProgress(1f)
            SavedShortVideo(uri, name, durationUs / 1000)
        }.also { pending = null }
    } finally {
        pending?.let { runCatching { app.contentResolver.delete(it, null, null) } }
        temporary.forEach { it.delete() }
        timeline.forEach { it.pcm.fill(0) }
    }
}

internal data class ExportScene(val scene: Scene, val pcm: ByteArray, val startUs: Long) {
    val durationUs: Long get() = pcm.size.toLong() * 1_000_000 / (EXPORT_SAMPLE_RATE * 2)
}

internal fun exportTimeline(short: Short, clips: List<File>, control: ShortExportControl, maxSeconds: Int = EXPORT_MAX_SECONDS): List<ExportScene> {
    require(maxSeconds in 1..60)
    var remaining = EXPORT_SAMPLE_RATE * 2 * maxSeconds
    var start = 0L
    val timeline = mutableListOf<ExportScene>()
    for ((i, scene) in short.scenes.withIndex()) {
        if (remaining == 0) break
        control.check()
        val pcm = readExportPcm(clips[i], remaining)
        require(pcm.isNotEmpty()) { "장면 ${i + 1}의 원음이 비어 있어요" }
        val part = ExportScene(scene, pcm, start)
        timeline += part; start += part.durationUs; remaining -= pcm.size
    }
    return timeline
}

/** RIFF chunks can include JUNK/LIST and odd-byte padding; do not assume a 44-byte WAV header. */
internal fun readExportPcm(file: File, maxBytes: Int): ByteArray = RandomAccessFile(file, "r").use { input ->
    fun ascii(): String = ByteArray(4).also(input::readFully).toString(Charsets.US_ASCII)
    fun uint(): Long = Integer.reverseBytes(input.readInt()).toLong() and 0xffffffffL
    fun ushort(): Int = java.lang.Short.reverseBytes(input.readShort()).toInt() and 0xffff
    require(input.length() >= 12 && ascii() == "RIFF") { "원음이 WAV 형식이 아니에요" }
    uint()
    require(ascii() == "WAVE") { "원음이 WAV 형식이 아니에요" }
    var validFormat = false
    var dataOffset = -1L
    var dataBytes = 0L
    while (input.filePointer + 8 <= input.length()) {
        val tag = ascii(); val count = uint(); val begin = input.filePointer
        require(count <= input.length() - begin) { "원음 파일이 중간에 끊겼어요" }
        when (tag) {
            "fmt " -> {
                require(count >= 16) { "원음 형식 정보가 없어요" }
                val format = ushort(); val channels = ushort(); val rate = uint(); uint()
                val alignment = ushort(); val bits = ushort()
                require(format == 1 && channels == 1 && rate == EXPORT_SAMPLE_RATE.toLong() && bits == 16 && alignment == 2) {
                    "현재는 16kHz 모노 PCM16 원음만 영상으로 저장할 수 있어요"
                }
                validFormat = true
            }
            "data" -> { dataOffset = begin; dataBytes = count }
        }
        if (validFormat && dataOffset >= 0) break
        input.seek(begin + count + count % 2)
    }
    require(validFormat && dataOffset >= 0 && dataBytes > 0 && dataBytes % 2 == 0L) { "원음 데이터를 읽지 못했어요" }
    input.seek(dataOffset)
    ByteArray(minOf(dataBytes, maxBytes.toLong()).toInt()).also(input::readFully)
}

private class CodecTrack(private val muxer: MediaMuxer, private val control: ShortExportControl) {
    private var track = -1
    var started = false
        private set
    private val info = MediaCodec.BufferInfo()

    fun drain(codec: MediaCodec, untilEnd: Boolean = false): Boolean {
        val deadline = System.nanoTime() + 15_000_000_000L
        while (true) {
            control.check()
            when (val index = codec.dequeueOutputBuffer(info, if (untilEnd) CODEC_WAIT_US else 0)) {
                MediaCodec.INFO_TRY_AGAIN_LATER -> {
                    if (!untilEnd) return false
                    check(System.nanoTime() < deadline) { "영상 변환이 응답하지 않아요" }
                }
                MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    check(!started) { "영상 형식이 도중에 바뀌었어요" }
                    track = muxer.addTrack(codec.outputFormat); muxer.start(); started = true
                }
                else -> if (index >= 0) {
                    try {
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0) {
                            check(started) { "영상 형식이 준비되지 않았어요" }
                            val data = requireNotNull(codec.getOutputBuffer(index))
                            data.position(info.offset); data.limit(info.offset + info.size)
                            info.presentationTimeUs = info.presentationTimeUs.coerceAtLeast(0)
                            muxer.writeSampleData(track, data, info)
                        }
                    } finally { codec.releaseOutputBuffer(index, false) }
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return true
                }
            }
        }
    }
}

private fun encodeVideo(file: File, codecName: String, format: MediaFormat, timeline: List<ExportScene>, painter: ExportScenePainter,
                        control: ShortExportControl, progress: (Float) -> Unit) {
    val codec = MediaCodec.createByCodecName(codecName)
    var muxer: MediaMuxer? = null
    var surface: Surface? = null
    var renderer: ExportEglSurface? = null
    var running = false
    var muxStarted = false
    try {
        muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        surface = codec.createInputSurface()
        codec.start(); running = true
        renderer = ExportEglSurface(surface)
        val track = CodecTrack(muxer, control)
        val durationUs = timeline.sumOf { it.durationUs }
        val frames = ceil(durationUs * EXPORT_FPS / 1_000_000.0).toInt()
        for (frame in 0 until frames) {
            control.check()
            track.drain(codec); muxStarted = track.started
            val timeUs = frame.toLong() * 1_000_000 / EXPORT_FPS
            val part = timeline.last { timeUs >= it.startUs }
            painter.draw(part, (timeUs - part.startUs) / 1_000_000.0)
            renderer.draw(painter.bitmap, timeUs * 1000)
            track.drain(codec); muxStarted = track.started
            progress((frame + 1f) / frames)
        }
        codec.signalEndOfInputStream()
        track.drain(codec, untilEnd = true); muxStarted = track.started
        muxer.stop(); muxStarted = false
    } finally {
        renderer?.close(); surface?.release()
        if (running) runCatching { codec.stop() }
        codec.release()
        if (muxStarted) runCatching { muxer?.stop() }
        muxer?.release()
    }
}

private fun encodeAudio(file: File, codecName: String, format: MediaFormat, timeline: List<ExportScene>, control: ShortExportControl,
                        progress: (Float) -> Unit) {
    val pcm = ByteArray(timeline.sumOf { it.pcm.size })
    var at = 0
    timeline.forEach { it.pcm.copyInto(pcm, at); at += it.pcm.size }
    val codec = MediaCodec.createByCodecName(codecName)
    var muxer: MediaMuxer? = null
    var running = false
    var muxStarted = false
    try {
        muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start(); running = true
        val track = CodecTrack(muxer, control)
        var offset = 0
        var eos = false
        var lastInput = System.nanoTime()
        while (!eos) {
            control.check()
            track.drain(codec); muxStarted = track.started
            val index = codec.dequeueInputBuffer(CODEC_WAIT_US)
            if (index >= 0) {
                val buffer = requireNotNull(codec.getInputBuffer(index)); buffer.clear()
                val count = minOf(buffer.remaining(), pcm.size - offset) / 2 * 2
                require(count > 0 || offset == pcm.size) { "원음 변환 버퍼가 너무 작아요" }
                if (count > 0) buffer.put(pcm, offset, count)
                eos = offset == pcm.size
                val pts = offset.toLong() * 1_000_000 / (EXPORT_SAMPLE_RATE * 2)
                codec.queueInputBuffer(index, 0, count, pts, if (eos) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                offset += count; lastInput = System.nanoTime()
                progress(offset.toFloat() / pcm.size)
            } else check(System.nanoTime() - lastInput < 15_000_000_000L) { "원음 변환이 응답하지 않아요" }
        }
        track.drain(codec, untilEnd = true); muxStarted = track.started
        muxer.stop(); muxStarted = false
    } finally {
        if (running) runCatching { codec.stop() }
        codec.release()
        if (muxStarted) runCatching { muxer?.stop() }
        muxer?.release()
        pcm.fill(0)
    }
}

private fun combineTracks(video: File, audio: File, output: File, durationUs: Long, control: ShortExportControl, progress: (Float) -> Unit) {
    val sources = listOf(MediaExtractor(), MediaExtractor())
    var muxer: MediaMuxer? = null
    var started = false
    try {
        sources[0].setDataSource(video.path); sources[1].setDataSource(audio.path)
        muxer = MediaMuxer(output.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        val tracks = sources.mapIndexed { i, extractor ->
            val prefix = if (i == 0) "video/" else "audio/"
            val track = (0 until extractor.trackCount).firstOrNull { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith(prefix) == true }
                ?: throw IllegalStateException("완성된 ${if (i == 0) "영상" else "원음"} 트랙이 없어요")
            extractor.selectTrack(track)
            muxer.addTrack(extractor.getTrackFormat(track))
        }
        muxer.start(); started = true
        val buffer = ByteBuffer.allocateDirect(2 * 1024 * 1024)
        val info = MediaCodec.BufferInfo()
        while (true) {
            control.check()
            val next = sources.indices.filter { sources[it].sampleTime in 0 until durationUs }.minByOrNull { sources[it].sampleTime } ?: break
            val extractor = sources[next]
            buffer.clear()
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) break
            val flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
            info.set(0, size, extractor.sampleTime, flags)
            muxer.writeSampleData(tracks[next], buffer, info)
            progress((info.presentationTimeUs.toDouble() / durationUs).coerceIn(0.0, 1.0).toFloat())
            extractor.advance()
        }
        // AAC pads its final frame. An explicit final duration keeps both tracks within the 45-second limit.
        tracks.forEach { track ->
            control.check()
            info.set(0, 0, durationUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            muxer.writeSampleData(track, ByteBuffer.allocate(0), info)
        }
        muxer.stop(); started = false
    } finally {
        if (started) runCatching { muxer?.stop() }
        muxer?.release(); sources.forEach { it.release() }
    }
}

/** Canvas draws into a bitmap; EGL submits that bitmap to the codec's supported input Surface. */
private class ExportEglSurface(private val surface: Surface) : Closeable {
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var window: EGLSurface = EGL14.EGL_NO_SURFACE
    private var program = 0
    private var texture = 0
    private val positions = floats(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)
    private val coordinates = floats(0f, 1f, 1f, 1f, 0f, 0f, 1f, 0f)

    init {
        try {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
            check(display != EGL14.EGL_NO_DISPLAY && EGL14.eglInitialize(display, null, 0, null, 0)) { "영상 그래픽을 시작하지 못했어요" }
            val configs = arrayOfNulls<EGLConfig>(1); val count = IntArray(1)
            val attributes = intArrayOf(EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_ALPHA_SIZE, 8, EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT, 0x3142, 1, EGL14.EGL_NONE) // EGL_RECORDABLE_ANDROID
            check(EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) && count[0] > 0) { "이 차량의 영상 그래픽 형식이 맞지 않아요" }
            val config = requireNotNull(configs[0])
            context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
            window = EGL14.eglCreateWindowSurface(display, config, surface, intArrayOf(EGL14.EGL_NONE), 0)
            check(context != EGL14.EGL_NO_CONTEXT && window != EGL14.EGL_NO_SURFACE && EGL14.eglMakeCurrent(display, window, window, context)) { "영상 화면을 준비하지 못했어요" }
            val vertex = shader(GLES20.GL_VERTEX_SHADER, "attribute vec2 p; attribute vec2 uv; varying vec2 t; void main(){gl_Position=vec4(p,0.0,1.0);t=uv;}")
            val fragment = shader(GLES20.GL_FRAGMENT_SHADER, "precision mediump float; varying vec2 t; uniform sampler2D image; void main(){gl_FragColor=texture2D(image,t);}")
            program = GLES20.glCreateProgram()
            GLES20.glAttachShader(program, vertex); GLES20.glAttachShader(program, fragment); GLES20.glLinkProgram(program)
            GLES20.glDeleteShader(vertex); GLES20.glDeleteShader(fragment)
            val linked = IntArray(1); GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0)
            check(linked[0] != 0) { "영상 그리기 프로그램을 만들지 못했어요" }
            val textures = IntArray(1); GLES20.glGenTextures(1, textures, 0); texture = textures[0]
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        } catch (e: Throwable) { close(); throw e }
    }

    fun draw(bitmap: Bitmap, presentationNanos: Long) {
        GLES20.glViewport(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT)
        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0); GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "image"), 0)
        val p = GLES20.glGetAttribLocation(program, "p"); val uv = GLES20.glGetAttribLocation(program, "uv")
        GLES20.glEnableVertexAttribArray(p); GLES20.glEnableVertexAttribArray(uv)
        positions.position(0); coordinates.position(0)
        GLES20.glVertexAttribPointer(p, 2, GLES20.GL_FLOAT, false, 0, positions)
        GLES20.glVertexAttribPointer(uv, 2, GLES20.GL_FLOAT, false, 0, coordinates)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        check(GLES20.glGetError() == GLES20.GL_NO_ERROR) { "영상 장면을 그리지 못했어요" }
        check(EGLExt.eglPresentationTimeANDROID(display, window, presentationNanos) && EGL14.eglSwapBuffers(display, window)) { "영상 장면을 인코더에 보내지 못했어요" }
    }

    override fun close() {
        if (display != EGL14.EGL_NO_DISPLAY) {
            if (texture != 0) GLES20.glDeleteTextures(1, intArrayOf(texture), 0)
            if (program != 0) GLES20.glDeleteProgram(program)
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            if (window != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, window)
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
            EGL14.eglReleaseThread(); EGL14.eglTerminate(display)
        }
        display = EGL14.EGL_NO_DISPLAY; context = EGL14.EGL_NO_CONTEXT; window = EGL14.EGL_NO_SURFACE
    }

    private fun shader(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, source); GLES20.glCompileShader(shader)
        val status = IntArray(1); GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
        if (status[0] == 0) { GLES20.glDeleteShader(shader); error("영상 그리기 프로그램이 지원되지 않아요") }
        return shader
    }

    private fun floats(vararg values: Float) = ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(values); position(0) }
}

private class ExportScenePainter(context: Context, private val short: Short, private val people: List<Person>) : Closeable {
    val bitmap: Bitmap = Bitmap.createBitmap(EXPORT_WIDTH, EXPORT_HEIGHT, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap).apply { scale(EXPORT_WIDTH / 540f, EXPORT_HEIGHT / 960f) }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG)
    private val mint = Color.rgb(111, 211, 166)
    private val ink = Color.rgb(244, 241, 236)
    private val resources = context.resources
    // 실제로 등장하는 설정만 열어 20개 전신 이미지를 한꺼번에 메모리에 올리지 않습니다.
    private val characters = mutableMapOf<ShortCharacter, Pair<Bitmap, android.graphics.Rect>>()

    fun draw(part: ExportScene, seconds: Double) {
        canvas.drawColor(Color.rgb(9, 11, 10))
        val cues = part.scene.cues
        val active = cueAt(cues, seconds)
        val cue = active ?: cues.lastOrNull { seconds >= it.start }
        centered(part.scene.label.ifBlank { "함께 남긴 장면" }, RectF(32f, 24f, 508f, 174f), 42f, ink, 2)
        cabin()
        val cast = shortSceneCast(short, part.scene, cue, people)
        val activeSpeaker = active?.let { shortSceneActor(it, short.cast, people).key }
        cast.forEachIndexed { slot, actor ->
            val speaking = actor.key == activeSpeaker
            val bob = if (speaking) (sin(seconds * 16.0) * 4.0).toFloat() else 0f
            val bounds = RectF(32f + slot * 260, 264f - bob, 248f + slot * 260, 586f - bob)
            paint.color = if (speaking) Color.argb(100, 111, 211, 166) else Color.argb(35, 111, 211, 166)
            canvas.drawOval(RectF(bounds.left + 12, 566f, bounds.right - 12, 590f), paint)
            if (actor.character != null) fit(actor.character, bounds) else mascot(bounds, speaking)
            if (speaking) {
                paint.color = mint; paint.strokeWidth = 5f; paint.strokeCap = Paint.Cap.ROUND
                repeat(3) { n -> canvas.drawLine(bounds.right - 38 + n * 12, 292f - n * 12, bounds.right - 32 + n * 12, 278f - n * 12 - bob, paint) }
            }
        }
        centered(cue?.who?.ifBlank { "화자 미확인" }.orEmpty(), RectF(30f, 620f, 510f, 660f), 26f, mint, 1)
        centered(cue?.text.orEmpty(), RectF(32f, 664f, 508f, 862f), 44f, ink, 5)
        centered("함께 남긴 원래 목소리", RectF(30f, 886f, 510f, 930f), 22f, Color.rgb(181, 173, 162), 1)
    }

    private fun cabin() {
        paint.color = Color.rgb(35, 54, 47); canvas.drawRoundRect(RectF(12f, 192f, 528f, 604f), 24f, 24f, paint)
        val window = Path().apply { moveTo(62f, 214f); lineTo(478f, 214f); lineTo(510f, 350f); lineTo(30f, 350f); close() }
        paint.color = Color.rgb(168, 199, 183); canvas.drawPath(window, paint)
        paint.color = Color.rgb(111, 149, 132)
        canvas.drawPath(Path().apply { moveTo(30f, 350f); lineTo(144f, 286f); lineTo(260f, 330f); lineTo(392f, 270f); lineTo(510f, 350f); close() }, paint)
        paint.color = Color.rgb(24, 37, 31); canvas.drawRoundRect(RectF(232f, 218f, 308f, 242f), 8f, 8f, paint)
        repeat(2) { i ->
            val x = 35f + i * 260
            paint.color = Color.rgb(107, 117, 105); canvas.drawRoundRect(RectF(x + 40, 300f, x + 165, 385f), 24f, 24f, paint)
            paint.color = Color.rgb(74, 88, 77); canvas.drawRoundRect(RectF(x, 356f, x + 210, 586f), 35f, 35f, paint)
            paint.color = Color.rgb(96, 112, 97); canvas.drawRoundRect(RectF(x + 14, 374f, x + 196, 574f), 30f, 30f, paint)
        }
        paint.color = Color.rgb(27, 40, 34); canvas.drawRoundRect(RectF(12f, 574f, 528f, 604f), 12f, 12f, paint)
    }

    /** PNG는 그대로 두고, 불투명한 전신·팔·소품 전체에 4px 여백을 더한 소스 영역을 사용합니다. */
    private fun visibleCharacterBounds(image: Bitmap): android.graphics.Rect {
        val pixels = IntArray(image.width * image.height)
        image.getPixels(pixels, 0, image.width, 0, 0, image.width, image.height)
        var left = image.width; var top = image.height; var right = -1; var bottom = -1
        for (y in 0 until image.height) for (x in 0 until image.width) {
            if (pixels[y * image.width + x] ushr 24 > 32) {
                left = minOf(left, x); top = minOf(top, y); right = maxOf(right, x); bottom = maxOf(bottom, y)
            }
        }
        return if (right < left || bottom < top) android.graphics.Rect(0, 0, image.width, image.height)
        else android.graphics.Rect((left - 4).coerceAtLeast(0), (top - 4).coerceAtLeast(0),
            (right + 5).coerceAtMost(image.width), (bottom + 5).coerceAtMost(image.height))
    }

    private fun fit(character: ShortCharacter, bounds: RectF) {
        val (image, source) = characters.getOrPut(character) {
            val decoded = BitmapFactory.decodeResource(resources, character.drawable,
                BitmapFactory.Options().apply { inScaled = false; inSampleSize = 1 })
                ?: error("캐릭터 전신 이미지를 열지 못했어요")
            decoded to visibleCharacterBounds(decoded)
        }
        val scale = minOf(bounds.width() / source.width(), bounds.height() / source.height())
        val w = source.width() * scale; val h = source.height() * scale
        val dst = RectF(bounds.centerX() - w / 2, bounds.centerY() - h / 2, bounds.centerX() + w / 2, bounds.centerY() + h / 2)
        paint.color = Color.WHITE; canvas.drawBitmap(image, source, dst, paint)
    }

    private fun mascot(bounds: RectF, speaking: Boolean) {
        val body = RectF(bounds.left + 28, bounds.centerY() - 56, bounds.right - 28, bounds.centerY() + 52)
        paint.color = mint; canvas.drawRoundRect(body, 28f, 28f, paint)
        paint.color = Color.WHITE; canvas.drawRoundRect(RectF(body.left + 24, body.top - 20, body.right - 24, body.top + 34), 20f, 20f, paint)
        paint.color = Color.rgb(40, 34, 27)
        canvas.drawCircle(body.centerX() - 22, body.centerY(), 5f, paint); canvas.drawCircle(body.centerX() + 22, body.centerY(), 5f, paint)
        canvas.drawOval(RectF(body.centerX() - 10, body.centerY() + 14, body.centerX() + 10, body.centerY() + if (speaking) 29 else 20), paint)
    }

    private fun centered(value: String, bounds: RectF, maxSize: Float, color: Int, lines: Int) {
        if (value.isEmpty()) return
        text.color = color; text.typeface = Typeface.create("sans-serif", Typeface.BOLD)
        var size = maxSize
        fun layout() = StaticLayout.Builder.obtain(value, 0, value.length, text, bounds.width().toInt())
            .setAlignment(Layout.Alignment.ALIGN_CENTER).setIncludePad(false).setLineSpacing(4f, 1f)
            .setMaxLines(lines).setEllipsize(TextUtils.TruncateAt.END).build()
        text.textSize = size
        var block = layout()
        while (size > 26f && (block.height > bounds.height() || block.getEllipsisCount(block.lineCount - 1) > 0)) {
            size -= 2; text.textSize = size; block = layout()
        }
        canvas.save(); canvas.clipRect(bounds); canvas.translate(bounds.left, bounds.top + (bounds.height() - block.height).coerceAtLeast(0f) / 2)
        block.draw(canvas); canvas.restore()
    }

    override fun close() { characters.values.forEach { it.first.recycle() }; bitmap.recycle() }
}

/** Inspect actual container samples and decode a video frame before offering the file. */
private fun validateRenderedShort(file: File, expectedDurationUs: Long) {
    val extractor = MediaExtractor()
    try {
        extractor.setDataSource(file.path)
        require(extractor.trackCount == 2) { "영상과 원음 트랙을 확인하지 못했어요" }
        val formats = (0 until extractor.trackCount).map(extractor::getTrackFormat)
        val video = formats.single { it.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
        val audio = formats.single { it.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
        require(video.getInteger(MediaFormat.KEY_WIDTH) == EXPORT_WIDTH && video.getInteger(MediaFormat.KEY_HEIGHT) == EXPORT_HEIGHT)
        require(audio.getInteger(MediaFormat.KEY_SAMPLE_RATE) == EXPORT_SAMPLE_RATE && audio.getInteger(MediaFormat.KEY_CHANNEL_COUNT) == 1)
        for ((index, format) in formats.withIndex()) {
            require(kotlin.math.abs(format.getLong(MediaFormat.KEY_DURATION) - expectedDurationUs) <= 1_000_000) { "영상과 원음 길이가 맞지 않아요" }
            require(MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format) != null) { "이 차량에서 영상을 재생할 수 없어요" }
            extractor.selectTrack(index)
            require(extractor.readSampleData(ByteBuffer.allocate(2 * 1024 * 1024), 0) > 0) { "재생할 트랙이 비어 있어요" }
            extractor.unselectTrack(index)
        }
    } finally { extractor.release() }
    android.media.MediaMetadataRetriever().use { reader ->
        reader.setDataSource(file.path)
        val frame = reader.getFrameAtTime(0, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            ?: error("영상 프레임을 재생하지 못했어요")
        try { require(frame.width == EXPORT_WIDTH && frame.height == EXPORT_HEIGHT) } finally { frame.recycle() }
    }
}
