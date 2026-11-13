package io.github.teampitcrew.gachita

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GleoTest {
    @Test fun wakeSpellings() {
        // 11/13 실측에서 STT가 적은 꼴과 이어 붙은 말
        listOf("글레오", "클레오", "클리오", "클레오야 오늘 날씨 어때", "헤이 글레오", "Gleo, 음악 틀어 줘", "글레오!").forEach { assertTrue(it, isWake(it)) }
    }

    @Test fun notWake() {
        // 낱말 앞에서만 찾는다. 집안 대화의 비슷한 소리는 넘긴다
        listOf("", "화장실 가고 싶어", "스클레오", "그래 오늘 가자", "클로이 어디 갔어", "레오 인형 챙겼어?").forEach { assertFalse(it, isWake(it)) }
    }
}
