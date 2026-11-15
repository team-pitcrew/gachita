package io.github.teampitcrew.gachita

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 차 안의 강한 화자 값(StrongVoice.kt): 보관·삭제와 판정 규칙. 모델 자체(JNI)는 단위 시험이 닿지 않아 에뮬레이터에서 본다. */
class StrongVoiceTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun v(vararg x: Float) = floatArrayOf(*x)
    private val dad = v(1f, 0f, 0f); private val mom = v(0.9f, 0.4f, 0f); private val kid = v(0f, 1f, 0f); private val sis = v(0f, 0.9f, 0.4f)
    // 참가자 id → 프로필 id. 손님(guest)은 프로필이 없다
    private val people = mapOf("p1" to "dad", "p2" to "mom", "p3" to "kid", "p4" to "sis", "p5" to null)
    private val front = listOf("p1", "p2"); private val rear = listOf("p3", "p4", "p5")

    @Test fun `등록자 모두가 값을 가졌을 때 줄 안에서 가장 가까운 사람으로 정한다`() {
        val sp = StrongPrints(tmp.root, TEST_SEAL)
        val enrolled = listOf("p1", "p2", "p3", "p4")
        assertNull("값이 하나도 없으면 1차 임베더로", sp.identify(dad, people, null, enrolled))
        sp.put("dad", dad); sp.put("mom", mom); sp.put("kid", kid)
        assertNull("등록자 가운데 값이 없는 사람(폰에서 등록)이 있으면 1차 임베더로", sp.identify(dad, people, front, enrolled))
        sp.put("sis", sis)
        val near = v(0.95f, 0.3f, 0f) // dad 0.954, mom 0.999: 둘 다 가깝지만 늘 가장 가까운 사람으로(미확인 0%)
        assertEquals(Pair("p2", "strong"), sp.identify(near, people, front, enrolled)!!.let { it.who to it.basis })
        assertEquals("줄을 알면 그 줄에서: 전체에서는 엄마가 더 가깝다", "p3", sp.identify(near, people, rear, enrolled)!!.who)
        assertEquals("줄을 모르면 모두에서", "p2", sp.identify(near, people, null, enrolled)!!.who)
        assertEquals("그 줄에 등록자가 없으면 모두에서", "p2", sp.identify(near, people, listOf("p5"), enrolled)!!.who)
        // 등록하지 않은 사람(서버 대조 값 없음)과 손님은 후보가 아니다
        assertEquals("p1", sp.identify(kid, people, null, listOf("p1"))!!.who)
        assertNull(sp.identify(kid, people, null, listOf("p5")))
        assertNull(sp.identify(kid, people, null, emptyList()))
    }

    @Test fun `값은 암호화해 두고 다시 등록하면 바꾸며 로그아웃하면 지운다`() {
        val file = File(tmp.root, "voice-strong.json")
        StrongPrints(tmp.root, TEST_SEAL).put("dad", dad)
        assertFalse("평문으로 두지 않음", file.readText().contains("dad"))
        val again = StrongPrints(tmp.root, TEST_SEAL) // 앱을 다시 켜도 남는다(프로필 등록과 수명이 같다)
        assertEquals("p1", again.identify(dad, people, null, listOf("p1"))!!.who)
        again.put("dad", kid) // 다시 등록
        assertEquals(1, again.size); assertTrue(again.identify(kid, people, null, listOf("p1"))!!.confidence > 0.99)
        again.clear()
        assertFalse(file.exists()); assertEquals(0, StrongPrints(tmp.root, TEST_SEAL).size)
        assertFalse("여행 파일이 아니라 dropTrip이 건드리지 않는다", tripFiles(tmp.root, "ABC123").any { it.name == "voice-strong.json" })
    }

    @Test fun `디지털 무음을 뺀다`() {
        val x = FloatArray(1600) { if (it in 320 until 800) 0.1f else 0f } // 10 ms 묶음 열 개 가운데 셋만 소리
        assertEquals(480, withoutSilence(x).size)
        assertEquals(0, withoutSilence(FloatArray(500)).size)
        assertEquals(170, withoutSilence(FloatArray(170) { 0.1f }).size) // 끝의 짧은 묶음도 남긴다
        assertEquals(1.0, cosine(dad, dad), 1e-9); assertEquals(0.0, cosine(dad, kid), 1e-9)
    }
}
