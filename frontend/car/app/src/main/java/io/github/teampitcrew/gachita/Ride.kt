package io.github.teampitcrew.gachita

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.Surface
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import org.json.JSONObject
import kotlin.math.abs

// 동승 연결(T46): 탑승자 폰이 띄운 1회용 QR을 주차 중인 차가 카메라로 읽고, 운전자가 고른 자리에 그 사람을 넣는다(#71, #195 계약).
// QR 해석과 빈자리는 화면·SDK와 무관한 규칙(단위 테스트 RideTest.kt). 카메라는 QrCamera.

/** 폰 QR의 글자 `{"type":"gachita-ride","version":1,"code":"…"}`에서 code. 우리 QR이 아니면 null(다른 QR, 주소, 옛 초대). */
fun rideCode(text: String): String? = runCatching {
    JSONObject(text).takeIf { it.optString("type") == "gachita-ride" && it.optInt("version") == 1 }?.optString("code")?.takeIf { it.isNotBlank() }
}.getOrNull()

/** 아무도 앉지 않은 자리(앞줄부터). */
fun freeSeats(t: Trip): List<Seat> = Seat.entries.filter { s -> t.people.none { it.seat == s.name } }

/**
 * 뒤를 보는 카메라(없으면 첫 카메라)로 미리보기와 QR 읽기를 한다. 처음 읽은 우리 QR 하나만 onCode로 넘기고(메인 스레드) 더 읽지 않는다.
 * ponytail: Camera2 + zxing(QR만). 차 실내 카메라를 일반 앱이 열 수 있는지는 실차에서 확인한다(에뮬레이터는 가상 장면 카메라).
 */
class QrCamera(ctx: Context, private val onCode: (String) -> Unit, private val onFail: (String) -> Unit) {
    private val cm = ctx.getSystemService(CameraManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val thread = HandlerThread("qr").apply { start() }
    private val bg = Handler(thread.looper)
    private val qr = QRCodeReader()
    @Volatile private var device: CameraDevice? = null
    @Volatile private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    @Volatile private var done = false

    /** 카메라가 내는 크기 가운데 가로 1280에 가까운 것. 미리보기 표면도 이 크기로 맞춘다. 카메라가 없으면 null. */
    fun size(): android.util.Size? = runCatching {
        val id = cameraId() ?: return null
        cm.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!
            .getOutputSizes(ImageFormat.YUV_420_888).minByOrNull { abs(it.width - 1280) }
    }.getOrNull()

    private fun cameraId(): String? = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
        ?: cm.cameraIdList.firstOrNull()

    @Suppress("MissingPermission") // 부르는 쪽이 CAMERA 권한을 받은 뒤에만 연다
    fun start(preview: Surface) {
        val id = cameraId() ?: return onFail("카메라가 없어요")
        val sz = size() ?: return onFail("카메라를 열지 못했어요")
        val r = ImageReader.newInstance(sz.width, sz.height, ImageFormat.YUV_420_888, 2).also { reader = it }
        r.setOnImageAvailableListener({ it.acquireLatestImage()?.use(::decode) }, bg)
        runCatching {
            cm.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(d: CameraDevice) {
                    if (done) { d.close(); return } // 열리기 전에 닫힘(주행 제한·닫기)
                    device = d
                    @Suppress("DEPRECATION") // 목록으로 만드는 것이 API 29부터 다 되는 가장 짧은 길
                    runCatching { d.createCaptureSession(listOf(preview, r.surface), object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(s: CameraCaptureSession) {
                            if (done) { s.close(); return }
                            session = s
                            runCatching {
                                s.setRepeatingRequest(d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply { addTarget(preview); addTarget(r.surface) }.build(), null, bg)
                            }.onFailure { fail("카메라를 열지 못했어요", it) }
                        }
                        override fun onConfigureFailed(s: CameraCaptureSession) { if (!done) fail("카메라를 열지 못했어요", null) }
                    }, bg) }.onFailure { if (!done) fail("카메라를 열지 못했어요", it) }
                }
                override fun onDisconnected(d: CameraDevice) { d.close(); if (!done) fail("카메라 연결이 끊겼어요", null) }
                override fun onError(d: CameraDevice, error: Int) { d.close(); fail("카메라를 쓸 수 없어요($error)", null) }
            }, bg)
        }.onFailure { fail("카메라를 열지 못했어요", it) }
        Log.i(TAG, "카메라 $id ${sz.width}×${sz.height}")
    }

    private fun fail(why: String, t: Throwable?) { Log.w(TAG, why, t); main.post { onFail(why) } }

    /** Y 평면만으로 읽는다(QR은 밝기만 본다). 우리 QR이 아니면 계속 찾는다. */
    private fun decode(img: android.media.Image) {
        if (done) return
        val y = img.planes[0]
        val buf = ByteArray(y.buffer.remaining()).also { y.buffer.get(it) }
        val src = PlanarYUVLuminanceSource(buf, y.rowStride, img.height, 0, 0, img.width, img.height, false)
        val text = runCatching { qr.decode(BinaryBitmap(HybridBinarizer(src)), mapOf(DecodeHintType.TRY_HARDER to true)).text }.getOrNull() ?: return
        if (rideCode(text) == null) { Log.i(TAG, "우리 QR이 아님"); return }
        done = true
        Log.i(TAG, "동승 QR 읽음")
        main.post { onCode(text) }
    }

    fun stop() {
        done = true
        runCatching { session?.close() }; runCatching { device?.close() }; runCatching { reader?.close() }
        thread.quitSafely()
    }

    companion object { private const val TAG = "GachitaRide" }
}
